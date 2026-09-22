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
  ok:true, project:"furia-mods-ia", version:"4.0.1",
  archiveDetection:["zip","rar","7z"]
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

async function fetchPage(url){
  const r=await fetch(url,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (Android) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"}});
  if(!r.ok) throw new Error(`Não foi possível acessar o link (HTTP ${r.status}).`);
  return r;
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

  // Common MediaFire download attributes plus URLs embedded in page scripts.
  for(const re of [
    /href=["']([^"']+)["'][^>]*(?:download|download_link|downloadButton)[^>]*>/gi,
    /(?:downloadLink|download_url|downloadUrl|directDownload|downloadUrlText)\s*[:=]\s*["']([^"']+)["']/gi,
    /https?:\/\/[^"'\\\s<>]+/gi
  ]){
    let m;
    while((m=re.exec(html))) add(m[1]||m[0]);
  }

  const ordered=candidates.sort((a,b)=>(/download/i.test(b)?1:0)-(/download/i.test(a)?1:0));
  for(const candidate of ordered){
    try{
      const x=await fetch(candidate,{redirect:"follow",method:"GET",headers:{
        "User-Agent":"Mozilla/5.0","Range":"bytes=0-4095"
      }});
      const xct=x.headers.get("content-type")||"";
      const xcd=x.headers.get("content-disposition")||"";
      const type=archiveType(xcd,xct,x.url);
      const name=dispositionName(xcd);
      if(x.ok && (type || isArchiveName(x.url) || isArchiveName(name))){
        try{await x.body?.cancel()}catch{}
        return {downloadUrl:x.url,filename:name,type:type||archiveType(name,"",x.url)||"DESCONHECIDO"};
      }
      try{await x.body?.cancel()}catch{}
    }catch{}
  }
  throw new Error("O MediaFire não expôs um download de arquivo reconhecível.");
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
  const text=files.filter(x=>/\.(txt|md|xml|json|cfg|ini|lua|js)$/i.test(x.rel)).map(x=>x.rel).slice(0,50);
  const meta=await readFirst(files,/^meta\.xml$/i);
  const readme=await readFirst(files,/^(readme|leia[-_ ]?me)(\.[^.]+)?$/i);
  const top=[...new Set(files.map(x=>x.rel.split("/")[0]).filter(Boolean))].slice(0,50);
  return {fileCount:files.length,totalBytes:files.reduce((a,x)=>a+x.size,0),images,text,metaXml:meta,readme,topLevel:top,files:files.map(x=>x.rel).slice(0,100)};
}
function preview(name,a){
  const title=name.replace(/\.(zip|rar|7z)$/i,"").replace(/[_-]+/g," ").trim();
  return {titulo:title||"Mod sem título identificado",descricao:"Descrição será preenchida a partir das informações encontradas no mod.",autor:"Identificar no arquivo",comandos:"Identificar no arquivo",peso:`${(a.totalBytes/1024).toFixed(1)} KB`,imagem:a.images[0]||null};
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
    out=path.join(os.tmpdir(),`furia-out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.mkdir(out);
    let type=resolved.type;
    // If the host omitted the extension/type, 7-Zip itself will identify the format.
    const analysis=await analyzeArchive(archive,out);
    if(type==="DESCONHECIDO"){
      const n=resolved.filename||"";
      type=archiveType(n,"",resolved.downloadUrl)||"ARQUIVO";
    }
    res.json({ok:true,version:"4.0.1",sourceUrl:source,downloadUrl:resolved.downloadUrl,file:{
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

app.listen(PORT,()=>console.log(`Fúria Mods IA V4.0 rodando na porta ${PORT}`));
