// Owner-authorized selected accounts only. Secrets enter Docker through stdin;
// stdout contains counts only. Existing configured credentials remain intact.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readPrivate } = require('./private-account-input.cjs');
const root = path.resolve(__dirname, '..');
const source = process.argv[2];
function run(command, args, input) {
  const r = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw Error('Private operation failed; output suppressed');
  return r.stdout;
}
const code = `
const {PrismaClient}=require('@prisma/client');const {ConfigService}=require('@nestjs/config');
const {CredentialEncryptionService}=require('./dist/credentials/credential-encryption.service');
const {CredentialsService}=require('./dist/credentials/credentials.service');
const p=new PrismaClient(), config=new ConfigService(), encryption=new CredentialEncryptionService(config), credentials=new CredentialsService(p,encryption,config);
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{try{
const {rows,google}=JSON.parse(input);if(google.loginUsername!=='nguyenhuy.bvy@gmail.com')throw Error('Wrong Google identity');
const accounts=await p.platformAccount.findMany({where:{settings:{path:['extensionImport','selected'],equals:true}},include:{credential:true}});
if(accounts.length!==42)throw Error('Selection changed');
let passwords=0;
for(const a of accounts){const s=a.settings,auth=s.extensionSession;if(auth?.deviceId!=='93e21644-21f8-4d5c-8778-725d72f52093')throw Error('Chrome changed');
const stored=a.credential?.status==='ACTIVE'?encryption.decrypt(a.credential.encryptedPayload):{};
const methods={google:{username:google.loginUsername,password:google.password}};
// Preserve a valid social credential, including the Excel-resolved conflicts.
if(auth.provider==='password'&&stored.extensionLogin?.password)methods.password=stored.extensionLogin;
else {const candidates=rows.filter(r=>(s.extensionImport.sources||[]).includes(r.source)&&r.provider==='password'&&r.password);
if(candidates.length===1)methods.password={username:candidates[0].loginUsername,password:candidates[0].password,...(candidates[0].totpSecret?{totpSecret:candidates[0].totpSecret}:{})};}
if(methods.password)passwords++;
await credentials.merge(a.id,{extensionLoginMethods:methods});
await p.platformAccount.update({where:{id:a.id},data:{settings:{...s,extensionLoginMethods:{
password:{available:!!methods.password,username:methods.password?.username||'',autoTotp:!!methods.password?.totpSecret,loginUrl:auth.loginUrl||auth.origin},
google:{available:true,username:google.loginUsername,autoTotp:false,loginUrl:auth.loginUrl||auth.origin}
}}}});
}console.log(JSON.stringify({accounts:accounts.length,passwords,google:accounts.length}));
}catch{console.error('Private configuration failed');process.exitCode=1;}finally{await p.$disconnect();}});
`;
try {
  if (!source) throw Error('Pass the authorized account file path');
  const rows = JSON.parse(run('python', ['scripts/read-social-accounts.py', '--paste', source, '--brand', 'vpsttt', '--json']));
  const encoded = Buffer.from(code).toString('base64');
  process.stdout.write(run('docker', ['compose', 'exec', '-T', 'api', 'node', '-e', `eval(Buffer.from('${encoded}','base64').toString())`], JSON.stringify({ rows, google: readPrivate('google-override') })));
} catch (e) { console.error(e.message); process.exitCode = 1; }
