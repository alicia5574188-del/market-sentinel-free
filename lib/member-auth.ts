/** Random per-person login keys and independently scoped signed sessions.
 * Neither a member ID nor a client-supplied role grants any authority.
 */
export const MEMBERS_VERSION = "isolated-member-keys-v1";
export const MEMBER_COOKIE = "ms_member_session";
export const MEMBER_TTL = 30 * 86400;
export const MEMBER_LIMIT = 50;
export const MEMBER_ACTIVE_LIMIT = 2; // bounded initial rollout, never the primary owner
export const MEMBER_AUTH_VERSION = "invite-username-password-v1";
export const MEMBER_PASSWORD_ITERATIONS = 120_000;
const enc = new TextEncoder();
export const hex = (v: ArrayBuffer) => [...new Uint8Array(v)].map(x=>x.toString(16).padStart(2,"0")).join("");
export async function digestMember(value:string) { return hex(await crypto.subtle.digest("SHA-256",enc.encode(value))); }
export const randomHex = (n=24) => [...crypto.getRandomValues(new Uint8Array(n))].map(x=>x.toString(16).padStart(2,"0")).join("");
export const validMemberId = (id:unknown):id is string => typeof id==="string" && /^m_[a-f0-9]{32}$/.test(id);
export function equalSecret(a:string,b:string) { if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0; }
async function mac(secret:string,text:string) {
  if(secret.length<16)throw new Error("登录服务未配置");
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(await crypto.subtle.sign("HMAC",key,enc.encode(text)));
}
export async function memberVaultRoot(root:string,id:string) {
  if(!validMemberId(id))throw new Error("账户标识无效");
  return mac(root,`market-sentinel:member-vault:v1:${id}`);
}
export type MemberIdentity={id:string;version:number;expiresAt:number};
export async function issueMemberSession(root:string,id:string,version:number,now=Date.now()) {
  if(!validMemberId(id)||!Number.isSafeInteger(version)||version<1)throw new Error("账户无效");
  const text=`${id}.${version}.${Math.floor(now/1000)+MEMBER_TTL}.${randomHex(16)}`;
  return `${text}.${await mac(root,`market-sentinel:member-session:v1:${text}`)}`;
}
export function memberCookie(value:string) { return `${MEMBER_COOKIE}=${value}; Path=/; Max-Age=${MEMBER_TTL}; HttpOnly; Secure; SameSite=Strict`; }
export function clearMemberCookie() { return `${MEMBER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`; }
export async function verifyMemberSession(request:Request,root:string|undefined,now=Date.now()):Promise<MemberIdentity|null> {
  if(!root||root.length<16)return null;
  const found=(request.headers.get("Cookie")??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(MEMBER_COOKIE+"="));
  if(!found)return null;
  const token=found.slice(MEMBER_COOKIE.length+1);if(token.length>240)return null;
  const [id,version,expires,nonce,sig,...rest]=token.split(".");
  if(rest.length||!validMemberId(id)||!/^\d{1,8}$/.test(version)||!/^\d{10}$/.test(expires)||!/^\d+$/.test(version)
    ||!Number.isSafeInteger(Number(version))||Number(version)<1||!/^([a-f0-9]{32})$/.test(nonce??"")||!/^([a-f0-9]{64})$/.test(sig??""))return null;
  const expiry=Number(expires);if(expiry<=Math.floor(now/1000)||expiry>Math.floor(now/1000)+MEMBER_TTL+120)return null;
  const text=[id,version,expires,nonce].join(".");
  return equalSecret(sig,await mac(root,`market-sentinel:member-session:v1:${text}`))?{id,version:Number(version),expiresAt:expiry}:null;
}
export function parseLoginKey(raw:unknown) {
  if(typeof raw!=="string")return null;
  const key=raw.trim();return /^MS-[a-f0-9]{64}$/.test(key)?key:null;
}
export async function encryptMemberText(value:string,root:string,context:string) {
  const key=await crypto.subtle.importKey("raw",Uint8Array.from((await mac(root,`member-text:${context}`)).match(/../g)!,x=>parseInt(x,16)),"AES-GCM",false,["encrypt"]);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  return {iv:[...iv],bytes:[...new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:enc.encode(context)},key,enc.encode(value)))]};
}
export async function decryptMemberText(v:{iv:number[];bytes:number[]},root:string,context:string) {
  const key=await crypto.subtle.importKey("raw",Uint8Array.from((await mac(root,`member-text:${context}`)).match(/../g)!,x=>parseInt(x,16)),"AES-GCM",false,["decrypt"]);
  return new TextDecoder("utf-8",{fatal:true}).decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(v.iv),additionalData:enc.encode(context)},key,new Uint8Array(v.bytes)));
}
export function normalizeMemberUsername(raw:unknown) {
  if(typeof raw!=="string")return null;
  const display=raw.normalize("NFKC").trim();
  if(display.length<2||display.length>32||!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{1,31}$/u.test(display))return null;
  return {display,key:display.toLocaleLowerCase("en-US")};
}
export function normalizeInviteCode(raw:unknown) {
  if(typeof raw!=="string")return null;
  const code=raw.normalize("NFKC").trim().toUpperCase();
  return /^INV-[A-F0-9]{24}$/.test(code)?code:null;
}
export function validateMemberPassword(raw:unknown) {
  if(typeof raw!=="string"||raw.length<8||raw.length>128)return null;
  return raw;
}
async function derivePasswordHash(password:string,saltHex:string,iterations:number) {
  const salt=Uint8Array.from(saltHex.match(/../g)??[],x=>parseInt(x,16));
  const material=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},material,256));
}
export async function createMemberPassword(password:string) {
  const salt=randomHex(16),iterations=MEMBER_PASSWORD_ITERATIONS;
  return {salt,iterations,hash:await derivePasswordHash(password,salt,iterations)};
}
export async function verifyMemberPassword(password:string,record:{salt:string;iterations:number;hash:string}) {
  if(!/^[a-f0-9]{32}$/.test(record.salt)||!Number.isSafeInteger(record.iterations)||record.iterations<50_000||record.iterations>500_000
    ||!/^[a-f0-9]{64}$/.test(record.hash))return false;
  return equalSecret(await derivePasswordHash(password,record.salt,record.iterations),record.hash);
}
