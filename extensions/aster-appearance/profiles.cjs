'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
async function ensureAllProfiles(vscode,context){
  const index=path.join(path.dirname(context.extensionPath),'extensions.json');
  function scope(){
    if(!fs.existsSync(index))return undefined;
    const entries=JSON.parse(fs.readFileSync(index,'utf8'));
    const metadata=entries.find(item=>item.identifier?.id?.toLowerCase()==='workstation.aster-appearance')?.metadata;
    if(!metadata || typeof metadata!=='object')return undefined;
    if(metadata.isApplicationScoped===true)return true;
    if(metadata.isApplicationScoped===false||metadata.isApplicationScoped===undefined)return false;
  }
  if(scope()===true)return{status:'application-scoped'};
  if(scope()!==false)return{status:'not-verified',reason:'IDE не сообщает, общее ли расширение для всех профилей. Включите это в меню расширения: «Применить расширение ко всем профилям».'};
  const command='workbench.extensions.action.toggleApplyToAllProfiles';
  if(!vscode.version.startsWith('1.107.')||!(await vscode.commands.getCommands(true)).includes(command))return{status:'not-verified',reason:'Для этой версии IDE общий для всех профилей режим не проверен. Включите его в меню расширения.'};
  const key=crypto.createHash('sha256').update(context.extensionPath).digest('hex').slice(0,24),lock=path.join(os.tmpdir(),'aster-application-scope-'+key+'.lock');
  let descriptor;
  try {descriptor=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')return{status:'busy',reason:'Другое окно IDE уже включает расширение для всех профилей.'};throw error;}
  try{
    fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,source:context.extensionPath}));
    if(scope()===true)return{status:'application-scoped'};
    await vscode.commands.executeCommand(command,'workstation.aster-appearance',{location:context.extensionUri});
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if(scope()===true)return{status:'application-scoped',changed:true};await new Promise(resolve=>setTimeout(resolve,100));}
    return{status:'not-verified',reason:'IDE не подтвердила общий для всех профилей режим. Включите его в меню расширения.'};
  }finally{fs.closeSync(descriptor);fs.unlinkSync(lock);}
}
module.exports={ensureAllProfiles};
