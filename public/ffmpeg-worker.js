// Same-origin FFmpeg.wasm 0.12 worker. Kept local because browsers block CDN workers.
const TYPES={LOAD:"LOAD",EXEC:"EXEC",FFPROBE:"FFPROBE",WRITE_FILE:"WRITE_FILE",READ_FILE:"READ_FILE",DELETE_FILE:"DELETE_FILE",RENAME:"RENAME",CREATE_DIR:"CREATE_DIR",LIST_DIR:"LIST_DIR",DELETE_DIR:"DELETE_DIR",ERROR:"ERROR",PROGRESS:"PROGRESS",LOG:"LOG",MOUNT:"MOUNT",UNMOUNT:"UNMOUNT"};
let ffmpeg;
async function load({coreURL,wasmURL,workerURL}={}) {
  if(!coreURL) throw new Error("FFmpeg core URL is missing");
  let factory;
  try { importScripts(coreURL); factory=self.createFFmpegCore; } catch (_) {
    const imported=await import(coreURL);
    factory=imported.default||self.createFFmpegCore;
  }
  if(typeof factory!=="function") throw new Error("Could not load FFmpeg core factory (module exports: "+Object.keys(imported||{}).join(", ")+")");
  const actualWasm=wasmURL||coreURL.replace(/.js$/,".wasm");
  const actualWorker=workerURL||coreURL.replace(/.js$/,".worker.js");
  ffmpeg=await factory({mainScriptUrlOrBlob:coreURL+"#"+btoa(JSON.stringify({wasmURL:actualWasm,workerURL:actualWorker}))});
  ffmpeg.setLogger(data=>self.postMessage({type:TYPES.LOG,data}));
  ffmpeg.setProgress(data=>self.postMessage({type:TYPES.PROGRESS,data}));
  return true;
}
function execute({id,type,data}) {
  if(type!==TYPES.LOAD&&!ffmpeg) throw new Error("ffmpeg is not loaded, call await ffmpeg.load() first");
  switch(type) {
    case TYPES.LOAD: return load(data||{});
    case TYPES.EXEC: ffmpeg.setTimeout(data.timeout??-1); {const ret=ffmpeg.exec(...data.args);const code=ffmpeg.ret;ffmpeg.reset();return code;}
    case TYPES.FFPROBE: ffmpeg.setTimeout(data.timeout??-1); {ffmpeg.ffprobe(...data.args);const code=ffmpeg.ret;ffmpeg.reset();return code;}
    case TYPES.WRITE_FILE: ffmpeg.FS.writeFile(data.path,data.data);return true;
    case TYPES.READ_FILE: return ffmpeg.FS.readFile(data.path,{encoding:data.encoding});
    case TYPES.DELETE_FILE: ffmpeg.FS.unlink(data.path);return true;
    case TYPES.RENAME: ffmpeg.FS.rename(data.oldPath,data.newPath);return true;
    case TYPES.CREATE_DIR: ffmpeg.FS.mkdir(data.path);return true;
    case TYPES.LIST_DIR: return ffmpeg.FS.readdir(data.path).map(name=>({name,isDir:ffmpeg.FS.isDir(ffmpeg.FS.stat(data.path+"/"+name).mode)}));
    case TYPES.DELETE_DIR: ffmpeg.FS.rmdir(data.path);return true;
    case TYPES.MOUNT: {const fs=ffmpeg.FS.filesystems[data.fsType];if(!fs)return false;ffmpeg.FS.mount(fs,data.options,data.mountPoint);return true;}
    case TYPES.UNMOUNT: ffmpeg.FS.unmount(data.mountPoint);return true;
    default: throw new Error("unknown message type: "+type);
  }
}
self.onmessage=async ({data:{id,type,data}})=>{
  try {
    const result=await execute({id,type,data});
    const transfer=[];
    if(result instanceof Uint8Array) transfer.push(result.buffer);
    self.postMessage({id,type,data:result},transfer);
  } catch(error) {
    self.postMessage({id,type:TYPES.ERROR,data:String(error)});
  }
};
