
let ID_COUNTER = 0;
export function uniqueId(){
  return [
    padString(Date.now().toString(32), 8),
    padString((ID_COUNTER++).toString(32), 8),
    padString(Math.random().toString(32).substring(2, 10), 8),
  ].join("-");
}

export function padString(str: string, length: number, padChar: string = "0"){
  if(str.length >= length) return str.slice(0, length);
  return padChar.repeat(length - str.length) + str;
}

export function strToBuffer(str: string) {
  return new TextEncoder().encode(str);
}

export function bufferToStr(buffer: Uint8Array){
  return new TextDecoder().decode(buffer);
}

export function uint8ArrayToHex(array: Uint8Array){
  return Array.from(array)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToUint8Array(hexStr: string){
  return Uint8Array.from(
    hexStr.match(/.{2}/g)!,
    b => parseInt(b, 16)
  );
}


export function fileExtension(filepath: string){
  const normalized = filepath.replaceAll("\\", "/");
  const fileName = normalized.split("/").pop();
  if(!fileName) return;
  const lastDot = fileName.lastIndexOf(".");
  if(lastDot === -1) return;
  if(lastDot === 0) return;
  return fileName.slice(lastDot)
}
