const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin");
let chromium = null;
try { ({ chromium } = require("playwright")); } catch (e) { console.warn("Playwright não disponível; fallback de navegador desativado."); }

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_DOWNLOAD_MB = Number(process.env.MAX_DOWNLOAD_MB || 500);
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * 1024 * 1024;

// Render/Linux pode instalar o binário do 7-Zip sem a permissão de execução.
// Garantimos a permissão antes de qualquer tentativa de descompactação.
try {
  fs.chmodSync(path7za, 0o755);
  console.log(`7-Zip pronto: ${path7za}`);
} catch (e) {
  console.warn(`Aviso: não foi possível ajustar a permissão do 7-Zip: ${e.message}`);
}

app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/health",(req,res)=>res.json({
  ok:true, project:"furia-mods-ia", version:"5.5.0",
  archiveDetection:["zip","rar","7z"], magicByteValidation:true
}));

function dispositionName(v){
  if(!v) return null;
  const m=v.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i);
  return m ? decodeURIComponent(m[1].replace(/^"|"$/g,"")) : null;
}
function isArchiveName(v){ return /\.(zip|rar|7z)$/i.test(v||""); }
function archiveType(name="",ct="",url=""){
  const s=`${name} ${ct} ${url}`.toLowerCase();
  if(s.includes(".rar")||s.includes("rar")) return "RAR";
  if(s.includes(".7z")||s.includes("7z")) return "7Z";
  if(s.includes(".zip")||s.includes("zip")) return "ZIP";
  return null;
}

// ===== Assinaturas de arquivo (magic bytes) =====
// Não confiamos apenas na extensão/Content-Type do MediaFire: conferimos os
// primeiros bytes do arquivo baixado antes de mandar pro 7-Zip.
const MAGIC_SIGNATURES = [
  {type:"ZIP", bytes:[0x50,0x4B,0x03,0x04]},
  {type:"ZIP", bytes:[0x50,0x4B,0x05,0x06]}, // zip vazio
  {type:"ZIP", bytes:[0x50,0x4B,0x07,0x08]}, // zip com spanning
  {type:"RAR", bytes:[0x52,0x61,0x72,0x21,0x1A,0x07]},
  {type:"7Z",  bytes:[0x37,0x7A,0xBC,0xAF,0x27,0x1C]}
];
async function detectArchiveTypeByMagicBytes(filePath){
  const fd=await fsp.open(filePath,"r");
  try{
    const buf=Buffer.alloc(8);
    await fd.read(buf,0,8,0);
    for(const sig of MAGIC_SIGNATURES){
      if(buf.slice(0,sig.bytes.length).equals(Buffer.from(sig.bytes))) return sig.type;
    }
    return null;
  } finally { await fd.close(); }
}
async function readHeadAsText(filePath,maxBytes=800){
  const fd=await fsp.open(filePath,"r");
  try{
    const buf=Buffer.alloc(maxBytes);
    const {bytesRead}=await fd.read(buf,0,maxBytes,0);
    return buf.slice(0,bytesRead).toString("utf8");
  } finally { await fd.close(); }
}

async function fetchPage(url){
  const r=await fetch(url,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"}});
  if(!r.ok) throw new Error(`Não foi possível acessar o link (HTTP ${r.status}).`);
  return r;
}

// Extrai especificamente o href do botão de download do MediaFire
// (<a id="downloadButton" href="...">), que é onde o link real do arquivo fica.
function decodeHtmlEntities(v=""){
  return v
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/&#x2F;/gi,"/")
    .replace(/&#47;/gi,"/");
}
function normalizeCandidateUrl(v,base){
  if(!v) return null;
  let value=decodeHtmlEntities(String(v).trim());
  if(!value) return null;
  // Alguns atributos vêm URL-encoded ou começam com //.
  try{ value=decodeURIComponent(value); }catch{}
  try{return new URL(value,base).toString();}catch{return null;}
}

// MediaFire já usou mais de uma forma para esconder/expor o link real.
// Atualmente podemos encontrar o endereço no href do downloadButton ou no
// data-scrambled-url (Base64). Não dependemos de um único formato.
function decodeScrambledUrl(value){
  if(!value) return null;
  let v=decodeHtmlEntities(String(value).trim());
  v=v.replace(/\s+/g,"");
  for(let i=0;i<2;i++){
    try{v=decodeURIComponent(v)}catch{}
  }
  if(/^https?:\/\//i.test(v) || /^\/\//.test(v)) return v;
  try{
    const normalized=v.replace(/-/g,"+").replace(/_/g,"/");
    const padded=normalized + "=".repeat((4-normalized.length%4)%4);
    const decoded=Buffer.from(padded,"base64").toString("utf8").trim();
    if(/^https?:\/\//i.test(decoded) || /^\/\//.test(decoded)) return decoded;
  }catch{}
  return null;
}
function extractMediaFireCandidates(html,baseUrl){
  const out=[];
  const add=(v)=>{
    const u=normalizeCandidateUrl(v,baseUrl);
    if(u && /^https?:\/\/download\d*\.mediafire\.com\//i.test(u) && !out.includes(u)) out.push(u);
  };

  // MediaFire pode colocar o link real no botão, no atributo obfuscado ou em JS.
  const allScrambled=/data-scrambled-url=["']([^"']+)["']/gi;
  let m;
  while((m=allScrambled.exec(html))){
    const decoded=decodeScrambledUrl(m[1]);
    if(decoded) add(decoded);
  }

  const directRe=/https?:\/\/download\d*\.mediafire\.com\/[^\s"'<>]+/gi;
  while((m=directRe.exec(html))) add(m[0].replace(/\\/g,""));

  // Alguns clientes do MediaFire/JDownloader encontram o link em kNO.
  const knoRe=/\bkNO\s*=\s*["'](https?:\/\/download\d*\.mediafire\.com\/[^"']+)["']/gi;
  while((m=knoRe.exec(html))) add(m[1].replace(/\\/g,""));

  const buttonRe=/<a\b[^>]*id=["']downloadButton["'][^>]*>/gi;
  while((m=buttonRe.exec(html))){
    const tag=m[0];
    const href=tag.match(/\bhref=["']([^"']+)["']/i);
    const scrambled=tag.match(/\bdata-scrambled-url=["']([^"']+)["']/i);
    const dataUrl=tag.match(/\b(?:data-url|data-href)=["']([^"']+)["']/i);
    if(scrambled){const u=decodeScrambledUrl(scrambled[1]); if(u)add(u)}
    if(dataUrl)add(dataUrl[1]);
    if(href)add(href[1]);
  }

  // Variante em que o id vem depois do href.
  const buttonAlt=/<a\b[^>]*href=["']([^"']+)["'][^>]*id=["']downloadButton["'][^>]*>/gi;
  while((m=buttonAlt.exec(html))) add(m[1]);

  // Outras variáveis comuns usadas pelo MediaFire.
  for(const re of [
    /\b(?:downloadLink|download_url|downloadUrl|directDownload|downloadUrlText)\s*[:=]\s*["']([^"']+)["']/gi,
    /["'](https?:\/\/download\d*\.mediafire\.com\/[^"]+)["']/gi
  ]){
    while((m=re.exec(html))){
      const raw=m[1]||m[0];
      add(decodeScrambledUrl(raw)||raw);
    }
  }
  return out;
}

function extractMediaFireQuickKey(url){
  try{
    const u=new URL(url);
    const m=u.pathname.match(/\/file\/([A-Za-z0-9]+)/i);
    if(m) return m[1];
    const q=u.searchParams.get("quick_key");
    return q || null;
  }catch{return null}
}

function collectMediaFireLinkCandidates(data){
  const out=[];
  const add=(v)=>{
    if(typeof v !== "string" || !/^https?:\/\//i.test(v)) return;
    if(!out.includes(v)) out.push(v);
  };
  const response=data?.response||data;
  const arrays=[response?.links,response?.file_info?.links,response?.file_infos?.[0]?.links];
  for(const links of arrays){
    if(Array.isArray(links)){
      for(const item of links){
        if(typeof item === "string") add(item);
        else if(item && typeof item === "object"){
          for(const key of ["direct_download","normal_download","download"]) add(item[key]);
        }
      }
    } else if(links && typeof links === "object"){
      for(const key of ["direct_download","normal_download","download"]) add(links[key]);
    }
  }
  for(const key of ["direct_download","normal_download","download"]){
    add(response?.[key]);
  }
  return out;
}
async function resolveMediaFireViaApi(url){
  const quickKey=extractMediaFireQuickKey(url);
  if(!quickKey) return null;
  // O endpoint correto para links de download é file/get_links.
  // get_info é útil para metadados, mas não é confiável como fonte do link real.
  const endpoints=[
    `https://www.mediafire.com/api/1.5/file/get_links.php?link_type=direct_download&quick_key=${encodeURIComponent(quickKey)}&response_format=json`,
    `https://www.mediafire.com/api/1.5/file/get_links.php?link_type=normal_download&quick_key=${encodeURIComponent(quickKey)}&response_format=json`,
    `https://www.mediafire.com/api/file/get_links.php?link_type=direct_download&quick_key=${encodeURIComponent(quickKey)}&response_format=json`,
    `https://www.mediafire.com/api/file/get_links.php?link_type=normal_download&quick_key=${encodeURIComponent(quickKey)}&response_format=json`
  ];
  for(const endpoint of endpoints){
    try{
      const r=await fetch(endpoint,{redirect:"follow",headers:{
        "User-Agent":"Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
        "Accept":"application/json,text/plain,*/*",
        "Referer":url
      }});
      if(!r.ok) continue;
      const text=await r.text();
      let data=null;
      try{data=JSON.parse(text)}catch{}
      const candidates=collectMediaFireLinkCandidates(data);
      // Algumas respostas antigas podem vir em XML mesmo pedindo JSON.
      const xmlCandidates=[];
      for(const re of [/<(?:direct_download|normal_download)>([^<]+)<\/(?:direct_download|normal_download)>/gi]){
        let m; while((m=re.exec(text))) xmlCandidates.push(m[1]);
      }
      for(const candidate of [...candidates,...xmlCandidates]){
        const probe=await probeArchiveCandidate(candidate);
        if(probe && probe.magic){
          return {downloadUrl:probe.downloadUrl,filename:probe.filename||null,type:probe.magic};
        }
      }
    }catch(e){
      console.warn(`MediaFire API get_links falhou: ${e.message}`);
    }
  }
  return null;
}

async function probeArchiveCandidate(url){
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    const r=await fetch(url,{redirect:"follow",signal:controller.signal,headers:{
      "User-Agent":"Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
      "Range":"bytes=0-8191",
      "Accept":"*/*"
    }});
    clearTimeout(timer);
    if(!r.ok) return null;
    const finalUrl=r.url;
    const ct=r.headers.get("content-type")||"";
    const cd=r.headers.get("content-disposition")||"";
    const name=dispositionName(cd);
    const reader=r.body?.getReader();
    let buf=Buffer.alloc(0);
    if(reader){
      const first=await reader.read();
      if(first.value) buf=Buffer.from(first.value);
      try{await reader.cancel()}catch{}
    }
    const magic=findMagicType(buf);
    const type=magic||archiveType(name,ct,finalUrl);
    if(!type) return null;
    return {downloadUrl:finalUrl,filename:name,type,magic};
  }catch{return null}
}
function findMagicType(buf){
  for(const sig of MAGIC_SIGNATURES){
    if(buf.length>=sig.bytes.length && buf.slice(0,sig.bytes.length).equals(Buffer.from(sig.bytes))) return sig.type;
  }
  return null;
}

async function resolveMediaFire(url){
  const r=await fetchPage(url);
  const finalUrl=r.url;
  const ct=r.headers.get("content-type")||"";
  const cd=r.headers.get("content-disposition")||"";
  // IMPORTANTE: a própria URL da página do MediaFire contém ".zip", mas isso
  // não significa que a resposta seja um ZIP. Nunca usamos a URL da página
  // para declarar que o conteúdo já é um arquivo.
  const directType=archiveType(cd,ct);
  if(directType) return {downloadUrl:finalUrl,filename:dispositionName(cd),type:directType};

  const html=await r.text();
  const candidates=extractMediaFireCandidates(html,finalUrl);
  console.log(`MediaFire: ${candidates.length} candidato(s) direto(s) encontrado(s) na página.`);

  for(const candidate of candidates){
    const probe=await probeArchiveCandidate(candidate);
    if(probe && probe.magic){
      console.log(`MediaFire: arquivo real encontrado em ${probe.downloadUrl}`);
      return {downloadUrl:probe.downloadUrl,filename:probe.filename||null,type:probe.magic};
    }
  }

  // Fallback importante: algumas respostas do MediaFire não entregam o
  // data-scrambled-url no HTML recebido pelo servidor, mas a API pública de
  // informações ainda consegue retornar os links do arquivo.
  const apiResult=await resolveMediaFireViaApi(url);
  if(apiResult){
    console.log(`MediaFire: arquivo real encontrado pela API em ${apiResult.downloadUrl}`);
    return apiResult;
  }

  throw new Error("O MediaFire foi acessado, mas o link direto do arquivo não foi resolvido automaticamente. O servidor tentou o botão/data-scrambled-url, links diretos na página e a API pública do MediaFire.");
}

async function resolveWithBrowser(url){
  if(!chromium) throw new Error("O navegador automático não está disponível no servidor.");
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser=await chromium.launch({
    headless:true,
    executablePath,
    args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  let context=null, page=null;
  try{
    context=await browser.newContext({acceptDownloads:true,userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36"});
    page=await context.newPage();
    let downloadResolve;
    const downloadPromise=new Promise(resolve=>{
      downloadResolve=resolve;
      page.once("download", d=>resolve(d));
      setTimeout(()=>resolve(null),45000);
    });
    let navigationDownload=false;
    try {
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    } catch (e) {
      // Playwright pode lançar quando a navegação inicia um download diretamente.
      if (/download|net::ERR_ABORTED/i.test(String(e?.message||e))) navigationDownload=true;
      else throw e;
    }
    const host=new URL(url).hostname.toLowerCase();

    // Aguarda o elemento real do MediaFire aparecer. Ele pode ser inserido
    // depois do carregamento inicial da página.
    if(host.includes("mediafire.com")){
      await page.locator('#downloadButton').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      const checkbox=page.locator('input[type="checkbox"]').first();
      if(await checkbox.count() && await checkbox.isVisible().catch(()=>false)) await checkbox.check().catch(()=>{});
      const selectors=[
        'button:has-text("Download Anyway")',
        'a:has-text("Download Anyway")',
        'button:has-text("Baixar mesmo assim")',
        'a:has-text("Baixar mesmo assim")',
        '#downloadButton',
        'a[id="downloadButton"]',
        'a[aria-label="Download file"]'
      ];
      let clicked=false;
      for(const selector of selectors){
        const el=page.locator(selector).first();
        if(await el.count() && await el.isVisible().catch(()=>false)){
          try {
            await el.scrollIntoViewIfNeeded();
            await el.click({timeout:10000});
            clicked=true;
            break;
          } catch {}
        }
      }
      if(!clicked){
        // Último fallback: procurar qualquer link/botão cujo texto indique download.
        const candidates=page.locator('a,button,input[type="button"],input[type="submit"]');
        const count=await candidates.count();
        for(let i=0;i<Math.min(count,80);i++){
          const el=candidates.nth(i);
          const text=((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('value').catch(()=>''))).trim().toLowerCase();
          if(text.includes('download') || text.includes('baixar')){
            try { await el.click({timeout:5000}); clicked=true; break; } catch {}
          }
        }
      }
    }

    // ShareMods normalmente exige Create download link e depois Start Download.
    if(host.includes("sharemods.com")){
      for(const selector of [
        'button:has-text("Create download link")',
        'a:has-text("Create download link")',
        'input[value*="Create download"]'
      ]){
        const el=page.locator(selector).first();
        if(await el.count() && await el.isVisible().catch(()=>false)){
          await el.click().catch(()=>{});
          break;
        }
      }
      await page.waitForTimeout(1500);
      for(const selector of [
        'button:has-text("Start Download")',
        'a:has-text("Start Download")',
        'button:has-text("Download")',
        'a[href*="cgi-bin/dl.cgi"]'
      ]){
        const el=page.locator(selector).first();
        if(await el.count() && await el.isVisible().catch(()=>false)){
          await el.click().catch(()=>{});
          break;
        }
      }
    }

    const dl=await downloadPromise;
    if(!dl && navigationDownload){
      // Navegação direta pode ter disparado o download antes do listener conseguir
      // materializá-lo. Recarregamos em uma nova aba e aguardamos explicitamente.
      const p2=await context.newPage();
      try{
        const d2=p2.waitForEvent('download',{timeout:20000}).catch(()=>null);
        await p2.goto(url,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});
        const got=await d2;
        if(got){
          const target=path.join(os.tmpdir(),`furia-browser-${Date.now()}-${Math.random().toString(16).slice(2)}.archive`);
          await got.saveAs(target);
          const magic=await detectArchiveTypeByMagicBytes(target);
          if(!magic){ try{await fsp.rm(target,{force:true})}catch{}; throw new Error("O navegador recebeu conteúdo que não é ZIP, RAR ou 7Z."); }
          return {localPath:target,filename:got.suggestedFilename(),type:magic};
        }
      } finally { await p2.close().catch(()=>{}); }
    }
    if(!dl) throw new Error("O navegador abriu a página, mas não recebeu um download do arquivo.");
    const target=path.join(os.tmpdir(),`furia-browser-${Date.now()}-${Math.random().toString(16).slice(2)}.archive`);
    await dl.saveAs(target);
    const magic=await detectArchiveTypeByMagicBytes(target);
    if(!magic){
      try{await fsp.rm(target,{force:true})}catch{}
      throw new Error("O navegador iniciou um download, mas o conteúdo recebido não é um ZIP, RAR ou 7Z válido.");
    }
    return {localPath:target,filename:dl.suggestedFilename(),type:magic};
  } finally {
    await browser.close().catch(()=>{});
  }
}

async function resolveDownload(url){
  const u=new URL(url);
  if(u.hostname.toLowerCase().includes("mediafire.com")) {
    try { return await resolveMediaFire(url); }
    catch (e) {
      console.warn(`MediaFire por HTTP falhou: ${e.message}. Tentando navegador automático...`);
      return resolveWithBrowser(url);
    }
  }

  const r=await fetchPage(url);
  const ct=r.headers.get("content-type")||"";
  const cd=r.headers.get("content-disposition")||"";
  const name=dispositionName(cd);
  const type=archiveType(name,ct,r.url);
  if(type) return {downloadUrl:r.url,filename:name,type};
  try { return await resolveWithBrowser(url); }
  catch (browserError) {
    throw new Error(`O link não entregou ZIP, RAR ou 7Z diretamente. Navegador automático também falhou: ${browserError.message}`);
  }
}

async function downloadFile(url,target){
  const r=await fetch(url,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0"}});
  if(!r.ok) throw new Error(`Falha no download (HTTP ${r.status}).`);
  const len=Number(r.headers.get("content-length")||0);
  if(len>MAX_DOWNLOAD_BYTES) throw new Error(`O arquivo excede o limite de ${MAX_DOWNLOAD_MB} MB.`);
  const out=fs.createWriteStream(target); let total=0;
  try{
    for await(const chunk of r.body){
      total+=chunk.length;
      if(total>MAX_DOWNLOAD_BYTES){out.destroy();throw new Error(`O arquivo excede o limite de ${MAX_DOWNLOAD_MB} MB.`);}
      if(!out.write(chunk)) await new Promise(ok=>out.once("drain",ok));
    }
    out.end();
    await new Promise((ok,bad)=>{out.on("finish",ok);out.on("error",bad)});
  }catch(e){out.destroy();throw e}
  return {bytes:total,contentType:r.headers.get("content-type")||""};
}

function extractArchive(archive,outDir){
  return new Promise((resolve,reject)=>{
    const child=spawn(path7za,["x","-y",`-o${outDir}`,archive],{stdio:["ignore","pipe","pipe"]});
    let err="";
    child.stderr.on("data",d=>err+=d.toString());
    child.on("error",reject);
    child.on("close",code=>{
      if(code===0) resolve();
      else reject(new Error(`Não foi possível descompactar o arquivo. O 7-Zip retornou código ${code}. ${err.slice(-800)}`));
    });
  });
}

async function walk(dir,root,arr=[]){
  for(const ent of await fsp.readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,ent.name);
    if(ent.isDirectory()) await walk(full,root,arr);
    else arr.push({full,rel:path.relative(root,full).replaceAll(path.sep,"/"),size:(await fsp.stat(full)).size});
    if(arr.length>=1000) break;
  }
  return arr;
}
async function readFirst(files,regex){
  const f=files.find(x=>regex.test(path.basename(x.rel)));
  if(!f)return null;
  try{return (await fsp.readFile(f.full,"utf8")).slice(0,20000)}catch{return null}
}
async function analyzeArchive(archive,outDir){
  await extractArchive(archive,outDir);
  const files=await walk(outDir,outDir,[]);
  const images=files.filter(x=>/\.(png|jpe?g|webp|gif)$/i.test(x.rel)).map(x=>x.rel).slice(0,30);
  const text=files.filter(x=>/\.(txt|md|xml|json|cfg|ini|lua|js)$/i.test(x.rel)).map(x=>x.rel).slice(0,100);
  const meta=await readFirst(files,/^meta\.xml$/i);
  const readme=await readFirst(files,/^(readme|leia[-_ ]?me)(\.[^.]+)?$/i);

  // Agora lemos o CONTEÚDO dos arquivos de texto, e não apenas os nomes.
  // O limite evita mandar um mod enorme inteiro para a resposta do servidor.
  const readable=files.filter(x=>/\.(txt|md|xml|json|cfg|ini|lua|js)$/i.test(x.rel)).slice(0,120);
  const contents=[];
  let totalChars=0;
  for(const f of readable){
    if(totalChars>=120000) break;
    try{
      const raw=await fsp.readFile(f.full,"utf8");
      const remaining=120000-totalChars;
      const content=raw.slice(0,Math.min(20000,remaining));
      contents.push({arquivo:f.rel,conteudo:content});
      totalChars+=content.length;
    }catch{}
  }

  const metadata=inferMetadata(contents,meta,readme);
  const top=[...new Set(files.map(x=>x.rel.split("/")[0]).filter(Boolean))].slice(0,50);
  return {
    fileCount:files.length,
    totalBytes:files.reduce((a,x)=>a+x.size,0),
    images,text,metaXml:meta,readme,topLevel:top,
    conteudo_textual:contents,
    metadata,
    files:files.map(x=>x.rel).slice(0,100)
  };
}

function cleanValue(v){
  return String(v||"").replace(/^[\s:\-–—]+|[\s]+$/g,"").replace(/[\r\n]+/g," ").trim();
}
function firstMatch(text,patterns){
  for(const re of patterns){const m=text.match(re);if(m&&m[1])return cleanValue(m[1]);}
  return null;
}
function inferMetadata(contents,metaXml,readme){
  const joined=contents.map(x=>`\n===== ${x.arquivo} =====\n${x.conteudo}`).join("\n");
  const meta=metaXml||"";
  const read=readme||"";
  const all=`${read}\n${meta}\n${joined}`;

  // Aceita português e inglês, pois créditos de mods frequentemente estão em inglês.
  const autor=firstMatch(all,[
    /(?:^|\n)\s*(?:autor|author|criador|creator|desenvolvedor|developer|desenvolvido por|created by|made by|by)\s*[:=\-]\s*([^\n|<]{2,120})/im,
    /<author[^>]*>([^<]{2,120})<\/author>/i,
    /<info[^>]*author\s*=\s*["']([^"']+)["']/i,
    /(?:cr[eé]ditos|credits)\s*[:=]\s*([^\n]{2,120})/i
  ]) || "Desconhecido";

  const versao=firstMatch(all,[
    /(?:^|\n)\s*(?:vers[aã]o|version|ver\.?|release)\s*[:=\-]\s*([^\n]{1,60})/im,
    /<info[^>]*version\s*=\s*["']([^"']+)["']/i,
    /<version[^>]*>([^<]+)<\/version>/i
  ]);

  const descricao=firstMatch(all,[
    /(?:^|\n)\s*(?:descri[cç][aã]o|description|sobre|about|o que [eé]|what it does)\s*[:=\-]\s*([^\n]{10,500})/im,
    /<info[^>]*description\s*=\s*["']([^"']+)["']/i,
    /<description[^>]*>([^<]{10,500})<\/description>/i
  ]);

  const comandos=firstMatch(all,[
    /(?:comandos?|commands?|commandos?)\s*[:=\-]\s*([\s\S]{2,500}?)(?=\n\s*(?:autor|author|descri[cç][aã]o|description|vers[aã]o|version|instala[cç][aã]o|installation)\s*[:=\-]|$)/i,
    /(?:use|usar|digite|type|execute|executar)\s+(\/[^\s,;.]{1,50}(?:\s+[^\n]{0,100})?)/i
  ]);

  const instalacao=firstMatch(all,[
    /(?:instala[cç][aã]o|installation|install|como instalar|how to install)\s*[:=\-]\s*([\s\S]{5,600}?)(?=\n\s*(?:autor|author|descri[cç][aã]o|description|comandos?|commands?|vers[aã]o|version)\s*[:=\-]|$)/i
  ]);

  const categoria=firstMatch(all,[
    /(?:categoria|category|tipo|type)\s*[:=\-]\s*([^\n]{2,80})/i
  ]);

  const dependencias=firstMatch(all,[
    /(?:depend[eê]ncias?|dependencies|requires|required resources?)\s*[:=\-]\s*([^\n]{2,300})/i
  ]);

  // Se o mod não declara uma descrição formal, pegamos uma frase útil do README/TXT.
  const fallbackDescription=descricao || (()=>{
    const source=read||contents.find(x=>/\.(txt|md)$/i.test(x.arquivo))?.conteudo||"";
    const lines=source.split(/\r?\n/).map(x=>cleanValue(x)).filter(x=>x.length>=25 && x.length<=500);
    return lines.find(x=>!/^([#=*\-]|autor|author|cr[eé]ditos|credits|comandos?|commands?|vers[aã]o|version)\b/i.test(x))||null;
  })();

  return {autor,descricao:fallbackDescription||"Não identificada",comandos:comandos||"Não identificados",versao:versao||"Não identificada",instalacao:instalacao||"Não identificada",categoria:categoria||"Não identificada",dependencias:dependencias||"Não identificadas"};
}
function preview(name,a){
  const title=name.replace(/\.(zip|rar|7z)$/i,"").replace(/[_-]+/g," ").trim();
  const m=a.metadata||{};
  return {
    titulo:title||"Mod sem título identificado",
    descricao:m.descricao||"Não identificada",
    autor:m.autor||"Desconhecido",
    comandos:m.comandos||"Não identificados",
    versao:m.versao||"Não identificada",
    categoria:m.categoria||"Não identificada",
    dependencias:m.dependencias||"Não identificadas",
    instalacao:m.instalacao||"Não identificada",
    peso:`${(a.totalBytes/1024).toFixed(1)} KB`,
    imagem:a.images[0]||null
  };
}

app.post("/api/analyze",async(req,res)=>{
  const source=String(req.body?.url||"").trim();
  if(!source)return res.status(400).json({ok:false,error:"Informe o link do mod."});
  let archive=null,out=null;
  try{
    new URL(source);
    const resolved=await resolveDownload(source);
    archive=path.join(os.tmpdir(),`furia-${Date.now()}-${Math.random().toString(16).slice(2)}.archive`);
    let dl;
    if(resolved.localPath){
      await fsp.copyFile(resolved.localPath,archive);
      const st=await fsp.stat(archive);
      dl={bytes:st.size,contentType:"application/octet-stream"};
      try{await fsp.rm(resolved.localPath,{force:true})}catch{}
    } else {
      dl=await downloadFile(resolved.downloadUrl,archive);
    }

    // ===== Validação por magic bytes (obrigatória antes de extrair) =====
    // Não confiamos na extensão/Content-Type: conferimos a assinatura real do
    // arquivo baixado. Se não bater com ZIP/RAR/7Z, avisamos claramente em vez
    // de deixar o 7-Zip falhar com um erro confuso.
    const magicType=await detectArchiveTypeByMagicBytes(archive);
    if(!magicType){
      const head=await readHeadAsText(archive,800);
      const looksHtml=/<html|<!doctype html/i.test(head);
      throw new Error(looksHtml
        ? "O MediaFire retornou uma página HTML em vez do arquivo real (provavelmente uma página intermediária ou de verificação). O download automático não encontrou o link direto do arquivo — tente novamente em alguns instantes ou confirme se o mod ainda está disponível no MediaFire."
        : "O arquivo baixado não corresponde a um ZIP, RAR ou 7Z válido (assinatura de arquivo não reconhecida).");
    }
    const type=magicType;

    out=path.join(os.tmpdir(),`furia-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.mkdir(out);
    const analysis=await analyzeArchive(archive,out);

    res.json({ok:true,version:"5.5.0",sourceUrl:source,downloadUrl:resolved.downloadUrl,file:{
      name:resolved.filename||path.basename(new URL(resolved.downloadUrl).pathname)||"mod",
      type,sizeMB:+(dl.bytes/1024/1024).toFixed(2),bytes:dl.bytes
    },analysis,preview:preview(resolved.filename||"mod",analysis)});
  }catch(e){
    console.error("ANALYZE_ERROR",e);
    res.status(400).json({ok:false,error:e.message||"Não foi possível analisar o mod."});
  }finally{
    if(archive)try{await fsp.rm(archive,{force:true})}catch{}
    if(out)try{await fsp.rm(out,{recursive:true,force:true})}catch{}
  }
});

app.listen(PORT,()=>console.log(`Fúria Mods IA V5.5 rodando na porta ${PORT}`));
