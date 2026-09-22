const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin");

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
  ok:true, project:"furia-mods-ia", version:"5.1.0",
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
function extractDownloadButtonHref(html){
  const tagMatch =
    html.match(/<a\b[^>]*id=["']downloadButton["'][^>]*>/i) ||
    html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*id=["']downloadButton["'][^>]*>/i);
  if(!tagMatch) return null;
  const hrefMatch=tagMatch[0].match(/href=["']([^"']+)["']/i);
  return hrefMatch ? hrefMatch[1] : null;
}

async function probeArchiveCandidate(url){
  try{
    const r=await fetch(url,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36","Range":"bytes=0-8191"}});
    if(!r.ok) return null;
    const finalUrl=r.url;
    const ct=r.headers.get("content-type")||"";
    const cd=r.headers.get("content-disposition")||"";
    const name=dispositionName(cd);
    const buf=Buffer.from(await r.arrayBuffer());
    const magic=findMagicType(buf);
    const type=magic||archiveType(name,ct,finalUrl);
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
  const directType=archiveType(cd,ct,finalUrl);
  if(directType) return {downloadUrl:finalUrl,filename:dispositionName(cd),type:directType};

  const html=await r.text();
  const candidates=[];
  const add=(u)=>{
    try{
      const a=new URL(u,finalUrl).toString();
      if(!candidates.includes(a)) candidates.push(a);
    }catch{}
  };

  // Primeiro tentamos o botão oficial do MediaFire.
  const buttonHref=extractDownloadButtonHref(html);
  if(buttonHref) add(buttonHref);

  // Depois procuramos outras formas usadas pelas diferentes versões do MediaFire.
  for(const re of [
    /href=["']([^"']+)["'][^>]*(?:download|download_link|downloadButton)[^>]*>/gi,
    /(?:downloadLink|download_url|downloadUrl|directDownload|downloadUrlText)\s*[:=]\s*["']([^"']+)["']/gi,
    /https?:\/\/[^"'\\\s<>]+/gi
  ]){
    let m;
    while((m=re.exec(html))) add(m[1]||m[0]);
  }

  const ordered=candidates.sort((a,b)=>
    (/download/i.test(b)?1:0)-(/download/i.test(a)?1:0)
  );

  // O ponto importante: não aceitamos simplesmente o primeiro href.
  // Testamos os bytes iniciais para confirmar que é realmente ZIP/RAR/7Z.
  for(const candidate of ordered){
    const probe=await probeArchiveCandidate(candidate);
    if(probe && probe.magic){
      return {downloadUrl:probe.downloadUrl,filename:probe.filename||null,type:probe.magic};
    }
  }

  throw new Error("O MediaFire foi acessado, mas não foi possível localizar automaticamente o arquivo ZIP, RAR ou 7Z. O servidor não encontrou um download real nos links expostos pela página.");
}
async function resolveDownload(url){
  const u=new URL(url);
  if(u.hostname.toLowerCase().includes("mediafire.com")) return resolveMediaFire(url);

  const r=await fetchPage(url);
  const ct=r.headers.get("content-type")||"";
  const cd=r.headers.get("content-disposition")||"";
  const name=dispositionName(cd);
  const type=archiveType(name,ct,r.url);
  if(type) return {downloadUrl:r.url,filename:name,type};
  throw new Error("O link não entregou ZIP, RAR ou 7Z diretamente. Links de página são resolvidos automaticamente para MediaFire.");
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
    const dl=await downloadFile(resolved.downloadUrl,archive);

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

    res.json({ok:true,version:"5.1.0",sourceUrl:source,downloadUrl:resolved.downloadUrl,file:{
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

app.listen(PORT,()=>console.log(`Fúria Mods IA V5.1 rodando na porta ${PORT}`));
