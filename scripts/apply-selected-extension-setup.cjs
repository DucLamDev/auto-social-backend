// Apply the operator's selected accounts without creating or retrying posts.
const { spawnSync } = require('node:child_process');
const { readPrivate } = require('./private-account-input.cjs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const google = readPrivate('google-override');
const code = `
const {PrismaClient}=require('@prisma/client');
const {ConfigService}=require('@nestjs/config');
const {CredentialEncryptionService}=require('./dist/credentials/credential-encryption.service');
const {CredentialsService}=require('./dist/credentials/credentials.service');
const {extensionFlowForPlatform}=require('./dist/connectors/extension/extension-flows');
const {parseExtensionDeliverySettings}=require('./dist/connectors/extension/extension-delivery');
const p=new PrismaClient(), config=new ConfigService(), encryption=new CredentialEncryptionService(config), credentials=new CredentialsService(p,encryption,config);
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',async()=>{try{
const google=JSON.parse(input); if(google.loginUsername!=='nguyenhuy.bvy@gmail.com')throw Error('Identity changed');
const accounts=await p.platformAccount.findMany({where:{settings:{path:['extensionImport','selected'],equals:true}},include:{platform:true,credential:true,extensionLoginChecks:{orderBy:{createdAt:'desc'},take:1}}});
if(accounts.length!==42||new Set(accounts.map(a=>a.ownerId)).size!==1)throw Error('Selection changed');
if(await p.publishJob.count({where:{platformAccountId:{in:accounts.map(a=>a.id)}}}))throw Error('Selected accounts have posts');
if(await p.extensionLoginCheck.count({where:{status:{in:['QUEUED','RUNNING']}}}))throw Error('Checks still active');
const result=[];
await p.$transaction(async tx=>{for(const a of accounts){const s=a.settings, auth=s.extensionSession;
if(auth.deviceId!=='93e21644-21f8-4d5c-8778-725d72f52093')throw Error('Chrome changed');
const stored=a.credential?.status==='ACTIVE'?encryption.decrypt(a.credential.encryptedPayload):{};
const login=stored.extensionLogin||{};
if(auth.provider==='google'||(!login.password&&auth.loginUsername.includes('@'))){
Object.assign(auth,{provider:'google',loginUsername:google.loginUsername,autoLogin:true,autoTotp:false,totpNeedsReview:true});
await credentials.upsert(a.id,{...stored,extensionLogin:{username:google.loginUsername,password:google.password}},null,tx);
}else if(login.password)auth.autoLogin=true;
auth.allowIdentityByEmail=auth.loginUsername.toLowerCase()===google.loginUsername;
s.extensionAutoConnect=true;
const flow=extensionFlowForPlatform(a.platform.slug);
if(flow&&flow.targetUrl){const parsed=parseExtensionDeliverySettings({extensionEngine:flow.engine,extensionTargetUrl:s.extensionTargetUrl||flow.targetUrl,extensionAutoSubmit:true,extensionTags:s.extensionTags||[],extensionCategory:s.extensionCategory||''});
Object.assign(s,{delivery:'extension',extensionEngine:parsed.engine,extensionTargetUrl:parsed.targetUrl,extensionAutoSubmit:true,extensionTags:parsed.tags||[],extensionCategory:parsed.category||'',extensionFlowId:flow.id,extensionFlowRevision:flow.revision,extensionSetup:{status:'READY'}});
s.extensionLoginTarget.engine=flow.engine;
}
const ready=s.delivery==='extension'&&a.extensionLoginChecks[0]?.status==='AUTHENTICATED';
await tx.platformAccount.update({where:{id:a.id},data:{settings:s,...(ready?{enabled:true,status:'CONNECTED'}:{})}});
result.push({name:a.name,provider:auth.provider,ready});
}},{timeout:30000});
console.log(JSON.stringify({accounts:result.length,ready:result.filter(r=>r.ready).map(r=>r.name)}));
}catch{console.error('Setup failed; private inputs suppressed');process.exitCode=1;}finally{await p.$disconnect();}});
`;
const encoded = Buffer.from(code).toString('base64');
const r = spawnSync('docker', ['compose', 'exec', '-T', 'api', 'node', '-e', `eval(Buffer.from('${encoded}','base64').toString())`], {
  cwd: root, input: JSON.stringify(google), encoding: 'utf8', windowsHide: true,
});
if (r.status !== 0) { console.error('Could not apply settings; private output suppressed'); process.exitCode = 1; }
else process.stdout.write(r.stdout);
