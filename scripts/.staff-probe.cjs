
const os=require('os'),fs=require('fs'),path=require('path');
const db=require(process.argv[2]);const B=require('better-sqlite3');
const out={};
const mk=(p)=>fs.mkdtempSync(path.join(os.tmpdir(),p));
const dirs=[];const fileIn=(d)=>path.join(d,'mission-minded.db');
const raw=(d)=>new B(fileIn(d));
const usersIn=(d)=>{const h=raw(d);const r=h.prepare('SELECT * FROM users ORDER BY id').all();h.close();return r;};
const meta=(d)=>{const h=raw(d);const m={sql:h.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql,
  idx:(h.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_username_event'").get()||{}).sql||'',
  seq:(h.prepare("SELECT seq FROM sqlite_sequence WHERE name='users'").get()||{}).seq,
  sv:h.pragma('schema_version',{simple:true}),root:h.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='users'").get().rootpage,
  fk:h.pragma('foreign_key_check').length};h.close();return m;};
// A users table of a given shape, every row and column carried, as a release's
// own rebuild would leave it.
const reshape=(d,usernameDef,roles)=>{const h=raw(d);h.pragma('foreign_keys = OFF');
  const seq=(h.prepare("SELECT seq FROM sqlite_sequence WHERE name='users'").get()||{}).seq;
  const cols='id,username,full_name,role,salt,hash,active,created_at,event_id,uid,updated_at,synced_rev,content_rev';
  h.exec("CREATE TABLE users_old (id INTEGER PRIMARY KEY AUTOINCREMENT, username "+usernameDef+", full_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ("+roles.map((r)=>"'"+r+"'").join(',')+")), salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, event_id INTEGER, uid TEXT, updated_at TEXT, synced_rev TEXT, content_rev TEXT);"
    +"INSERT INTO users_old ("+cols+") SELECT "+cols+" FROM users; DROP TABLE users; ALTER TABLE users_old RENAME TO users;");
  if(seq!=null)h.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='users'").run(seq);
  h.close();};
const ALL7=['admin','doctor','triage','emt','checkout','hygienist','registration'];
const boots=(d)=>{try{db.init(d);return true;}catch(e){try{db.close();}catch(_){}return String(e.message);}};
try{
  /* --- M: a database as v0.0.15 left it --- */
  const dM=mk('mmwstaffM-');dirs.push(dM);db.init(dM);db.ensureDeviceId();
  {const a=db.login('admin','admin');const ev=db.createEvent(a,{name:'Lowell Oct 18'});db.setActiveEvent(a,ev.id);
   const ana=db.createUser(a,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'ana-pw-1'});
   db.createUser(a,{username:'ben',full_name:'Ben Ortiz',role:'doctor',password:'ben-pw-1'});
   const gone=db.createUser(a,{username:'gone',full_name:'Gone Soon',role:'checkout',password:'gone-pw-1'});
   const p=db.createPatient(a,{first_name:'Mig',last_name:'Ration'});
   const it=db.saveInventoryItem(a,{name:'Gauze',unit:'pack'});
   const anaU=db.login('ana','ana-pw-1');
   db.recordInventoryMove(anaU,{item_id:it.id,delta:3,reason:'received'});
   const s=db.collectSyncRows(5000);db.markSynced(s.mark);
   db.deleteUser(a,gone.id);
   out.mAna=ana.id;out.mGone=gone.id;out.mPatient=p.id;}
  db.close();
  {const h=raw(dM);h.prepare('INSERT OR IGNORE INTO triage (patient_id) VALUES (?)').run(out.mPatient);
   h.prepare('UPDATE triage SET triaged_by=?, vitals_by=? WHERE patient_id=?').run(out.mAna,out.mAna,out.mPatient);h.close();}
  reshape(dM,'TEXT UNIQUE NOT NULL',ALL7);
  {const h=raw(dM);h.exec('DROP INDEX IF EXISTS idx_users_username_event');
   try{h.prepare("INSERT INTO users (username,full_name,role,salt,hash,created_at,event_id) VALUES ('ana','X','emt','s','h','t',999)").run();out.mFixture=false;}
   catch(e){out.mFixture=/UNIQUE/.test(e.message);}h.close();}
  const before=usersIn(dM),mBefore=meta(dM);
  db.init(dM);
  const mAfter=meta(dM),after=usersIn(dM);
  out.mShape={columnUnique:/username[^,]*UNIQUE/i.test(mAfter.sql),index:mAfter.idx,beforeUnique:/username[^,]*UNIQUE/i.test(mBefore.sql)};
  out.mRowsSame=JSON.stringify(before)===JSON.stringify(after)&&after.length>=3;
  out.mSeq=mAfter.seq>=out.mGone&&mBefore.seq>=out.mGone;
  out.mFk=mAfter.fk;
  {const h=raw(dM);out.mRefs={tri:h.prepare('SELECT triaged_by FROM triage WHERE patient_id=?').get(out.mPatient).triaged_by,
    mv:h.prepare('SELECT created_by FROM inventory_moves').get().created_by,
    au:h.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id=? AND action='login'").get(out.mAna).n};h.close();}
  out.mSignIn={ana:(db.login('ana','ana-pw-1')||{}).id===out.mAna,admin:!!db.login('admin','admin')};
  out.mClean=!db.collectSyncRows(5000).rows.some((r)=>r.entity==='user'&&!r.deleted);
  {const a=db.login('admin','admin');const evB=db.createEvent(a,{name:'Sandy Clinic'});
   try{const u2=db.createUser(a,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'ana-pw-2',event_id:evB.id});out.mSecond=u2.id;}catch(e){out.mSecond=String(e.message);}}
  db.close();
  const m1=meta(dM);db.init(dM);db.close();const m2=meta(dM);
  out.mOnce={same:m1.sv===m2.sv&&m1.root===m2.root,sv:[m1.sv,m2.sv]};

  /* --- R: a later release's role rebuild, on a database holding two events' ana --- */
  reshape(dM,'TEXT NOT NULL',ALL7.filter((r)=>r!=='registration'));
  {const h=raw(dM);h.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_event ON users(username, IFNULL(event_id, 0))');h.close();}
  const rBefore=usersIn(dM);
  out.rBoot=boots(dM);
  if(out.rBoot===true){db.close();const mR=meta(dM);const rAfter=usersIn(dM);
    out.rState={anas:rAfter.filter((u)=>u.username==='ana').length,same:JSON.stringify(rBefore)===JSON.stringify(rAfter),
      unique:/username[^,]*UNIQUE/i.test(mR.sql),registration:/'registration'/.test(mR.sql),index:!!mR.idx};}

  /* --- S: two laptops --- */
  const d1=mk('mmwstaff1-'),d2=mk('mmwstaff2-');dirs.push(d1,d2);
  db.init(d1);db.ensureDeviceId();
  let a1=db.login('admin','admin');db.updateUser(a1,a1.id,{password:'clinic-admin-pw'});a1=db.login('admin','clinic-admin-pw');
  const eA=db.createEvent(a1,{name:'Lowell Oct 18'}),eB=db.createEvent(a1,{name:'Sandy Clinic'});
  db.setActiveEvent(a1,eA.id);
  const anaA1=db.createUser(a1,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'ana-lowell'});
  db.createUser(a1,{username:'ben',full_name:'Ben Ortiz',role:'doctor',password:'ben-lowell'});
  db.setActiveEvent(a1,eB.id);
  db.createUser(a1,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'ana-sandy'});
  let snap=db.collectSyncRows(5000);db.markSynced(snap.mark);
  const rows1=snap.rows;
  const evUid=(name)=>(rows1.find((r)=>r.entity==='event'&&r.data.name===name)||{}).uid;
  const uA=evUid('Lowell Oct 18'),uB=evUid('Sandy Clinic');
  const anaUid=(eu)=>(rows1.find((r)=>r.entity==='user'&&r.data.username==='ana'&&r.event_uid===eu)||{}).uid;
  const ana1A=anaUid(uA),ana1B=anaUid(uB);
  out.sSent={anas:rows1.filter((r)=>r.entity==='user'&&r.data.username==='ana').length,distinct:!!ana1A&&!!ana1B&&ana1A!==ana1B};
  db.close();
  db.init(d2);db.ensureDeviceId();
  // This laptop's shipped admin under an identity of its own (set up before
  // the shared admin uid), which only the username guard can match.
  {const h=raw(d2);h.prepare("UPDATE users SET uid='laptop2-own-admin' WHERE username='admin'").run();h.close();}
  db.applyRemoteRows(rows1.filter((r)=>r.entity==='event'));
  const a2=db.login('admin','admin');
  const lA2=db.listEvents().find((e)=>e.uid===uA);
  // ...and its own "ana" for Lowell, typed in here before the first sync: the
  // same person on the same event, which the guard must adopt, not duplicate.
  db.createUser(a2,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'typed-on-laptop-2',event_id:lA2.id});
  const res2=db.applyRemoteRows(rows1.filter((r)=>r.entity!=='event'));
  {const us=db.listUsers();const h=raw(d2);const uidOf=(id)=>h.prepare('SELECT uid FROM users WHERE id=?').get(id).uid;
   const anas=us.filter((u)=>u.username==='ana');const lB2=db.listEvents().find((e)=>e.uid===uB);
   out.s2={anas:anas.length,events:anas.map((u)=>u.event_id).sort().join(',')===[lA2.id,lB2.id].sort().join(','),
     uids:anas.map((u)=>uidOf(u.id)).sort().join(',')===[ana1A,ana1B].sort().join(','),
     admins:us.filter((u)=>u.username==='admin').length,adminUid:uidOf(us.find((u)=>u.username==='admin').id),
     ben:us.filter((u)=>u.username==='ben').length,skipped:res2.skipped,deferred:res2.deferred};h.close();
   // Each on her own event: while an event has an ana, only that one signs in.
   const ad2=db.login('admin','clinic-admin-pw');const onEv=(e,pw)=>{db.setActiveEvent(ad2,e.id);return db.login('ana',pw)||{};};
   out.s2Login={adminClinic:!!ad2,adminShipped:!db.login('admin','admin'),
     lowell:onEv(lA2,'ana-lowell').event_id===lA2.id,sandy:onEv(lB2,'ana-sandy').event_id===lB2.id};
   // An edit to one of the two accounts here reaches that account only.
   const b2=anas.find((u)=>u.event_id===lB2.id);db.updateUser(db.login('admin','clinic-admin-pw'),b2.id,{full_name:'Ana M. Lopez'});}
  const rows2=db.collectSyncRows(5000);db.markSynced(rows2.mark);
  db.close();
  db.init(d1);db.applyRemoteRows(rows2.rows);
  {const anas=db.listUsers().filter((u)=>u.username==='ana');
   out.s1Back={anas:anas.length,renamedB:(anas.find((u)=>u.event_id===eB.id)||{}).full_name,keptA:(anas.find((u)=>u.event_id===eA.id)||{}).full_name};}
  // Start fresh on Lowell, here. Ana had recorded supplies and taken a survey
  // at check-out, which a foreign key used to refuse the deletion over.
  db.setActiveEvent(a1,eA.id);
  {const anaU=db.login('ana','ana-lowell');const it=db.saveInventoryItem(a1,{name:'Gauze',unit:'pack'});
   db.recordInventoryMove(anaU,{item_id:it.id,delta:2,reason:'received'});
   const p=db.createPatient(a1,{first_name:'Sur',last_name:'Vey'});db.saveExitSurvey(anaU,p.id,{declined:true});
   try{out.sFresh=db.clearEventStaff(a1,eA.id).deleted;}catch(e){out.sFresh=String(e.message);}
   const h=raw(d1);out.sNames={move:h.prepare('SELECT created_by, created_by_name FROM inventory_moves').get(),
     survey:h.prepare('SELECT completed_by, completed_by_name FROM exit_surveys').get()};h.close();}
  const rowsT=db.collectSyncRows(5000);db.markSynced(rowsT.mark);
  out.sTombs=rowsT.rows.filter((r)=>r.deleted&&r.entity==='user').map((r)=>r.uid);
  out.sTombsOk=out.sTombs.includes(ana1A)&&!out.sTombs.includes(ana1B)&&out.sTombs.length===2;
  db.close();
  db.init(d2);db.applyRemoteRows(rowsT.rows.filter((r)=>r.entity==='user'));
  {const us=db.listUsers();const h=raw(d2);const anas=us.filter((u)=>u.username==='ana');
   out.s2After={anas:anas.length,leftUid:anas.length===1?h.prepare('SELECT uid FROM users WHERE id=?').get(anas[0].id).uid===ana1B:false,
     ben:us.filter((u)=>u.username==='ben').length,
     tomb:{a:!!h.prepare('SELECT 1 FROM tombstones WHERE uid=?').get(ana1A),b:!!h.prepare('SELECT 1 FROM tombstones WHERE uid=?').get(ana1B)},
     signIn:!!db.login('ana','ana-sandy'),lowellDead:!db.login('ana','ana-lowell')};h.close();}
  db.close();

  /* --- N: a boot with an unscoped "ana" beside the active event's --- */
  const dN=mk('mmwstaffN-');dirs.push(dN);db.init(dN);
  {const a=db.login('admin','admin');db.createUser(a,{username:'ana',full_name:'Ana Lopez',role:'emt',password:'pw-event'});}
  db.close();
  {const h=raw(dN);h.prepare("INSERT INTO users (username,full_name,role,salt,hash,active,created_at,event_id) SELECT 'ana','Ana Unscoped','emt',salt,hash,1,created_at,NULL FROM users WHERE username='ana'").run();h.close();}
  out.nBoot=boots(dN);
  if(out.nBoot===true){db.close();const us=usersIn(dN).filter((u)=>u.username==='ana');out.nAnas={n:us.length,unscoped:us.filter((u)=>u.event_id==null).length};}

  /* --- U: the start-up lookups by username, with one name on two events --- */
  const dU=mk('mmwstaffU-');dirs.push(dU);db.init(dU);
  {const a=db.login('admin','admin');
   db.createUser(a,{username:'anna',full_name:'Anna Reed',role:'admin',password:'anna-pw-1'});
   const e1=db.createEvent(a,{name:'Lowell Oct 18'}),e2=db.createEvent(a,{name:'Sandy Clinic'});
   // The old demo password, on two events' "doctor".
   db.createUser(a,{username:'doctor',full_name:'Demo One',role:'doctor',password:'doctor',event_id:e1.id});
   db.createUser(a,{username:'doctor',full_name:'Demo Two',role:'doctor',password:'doctor',event_id:e2.id});
   // The clinic removed the shipped admin, and one event's EMT is called "admin".
   const anna=db.login('anna','anna-pw-1');db.deleteUser(anna,a.id);
   db.createUser(anna,{username:'admin',full_name:'Adam Min',role:'emt',password:'adam-pw-1',event_id:e1.id});}
  db.close();
  // An install from before the shipped-admin repair (no flag yet).
  {const h=raw(dU);h.prepare("DELETE FROM settings WHERE key='bootstrap_admin_v1'").run();h.close();}
  db.init(dU);
  out.uBoot={staffPw:(db.login('admin','adam-pw-1')||{}).full_name,shipped:(db.login('admin','admin')||{}).role};
  db.close();
  {const us=usersIn(dU);
   out.uBoot.demoOff=us.filter((u)=>u.username==='doctor'&&u.active===0).length;
   out.uBoot.staffRole=(us.find((u)=>u.username==='admin'&&u.event_id!=null)||{}).role;
   out.uBoot.globalAdmins=us.filter((u)=>u.username==='admin'&&u.event_id==null&&u.role==='admin').length;}

  /* --- D: a refused delete sends no deletion --- */
  const dD=mk('mmwstaffD-');dirs.push(dD);db.init(dD);db.ensureDeviceId();
  {const a=db.login('admin','admin');db.createUser(a,{username:'anna',full_name:'Anna Reed',role:'admin',password:'anna-pw-d'});
   let s=db.collectSyncRows(5000);db.markSynced(s.mark);
   const anna=db.login('anna','anna-pw-d');
   try{db.deleteUser(anna,anna.id);out.dRefused='allowed';}catch(e){out.dRefused=e.message;}
   s=db.collectSyncRows(5000);db.markSynced(s.mark);
   const h=raw(dD);out.dSent={tombs:h.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE entity='user'").get().n,
     deletions:s.rows.filter((r)=>r.deleted).length};h.close();
   // What the server hands back on the next pull: this laptop's own rows.
   const res=db.applyRemoteRows(s.rows);out.dKept={deleted:res.deleted,deferred:res.deferred,annaIn:!!db.login('anna','anna-pw-d')};}
  db.close();

  /* --- G: a deletion that would leave a laptop with no administrator --- */
  const g1=mk('mmwstaffG1-'),g2=mk('mmwstaffG2-');dirs.push(g1,g2);
  db.init(g1);db.ensureDeviceId();
  {let a=db.login('admin','admin');db.updateUser(a,a.id,{password:'clinic-pw-g'});a=db.login('admin','clinic-pw-g');
   db.createUser(a,{username:'anna',full_name:'Anna Reed',role:'admin',password:'anna-pw-g'});}
  const gRows=db.collectSyncRows(5000);db.markSynced(gRows.mark);
  {const anna=db.login('anna','anna-pw-g');db.deleteUser(anna,db.listUsers().find((u)=>u.username==='admin').id);}
  const gDel=db.collectSyncRows(5000);db.markSynced(gDel.mark);
  db.close();
  db.init(g2);db.ensureDeviceId();
  const isAnna=(r)=>r.entity==='user'&&r.data&&r.data.username==='anna';
  // The clinic's admin is here; Anna's account is still to come (a later page).
  db.applyRemoteRows(gRows.rows.filter((r)=>!isAnna(r)));
  db.login('admin','clinic-pw-g');
  const gR1=db.applyRemoteRows(gDel.rows);
  out.gHeld={deferred:gR1.deferred,deleted:gR1.deleted,adminIn:!!db.login('admin','clinic-pw-g')};
  db.applyRemoteRows(gRows.rows.filter(isAnna));
  const gR2=db.applyRemoteRows(gR1.deferredRows);
  out.gLater={deleted:gR2.deleted,deferred:gR2.deferred,adminIn:!!db.login('admin','clinic-pw-g'),annaIn:!!db.login('anna','anna-pw-g')};
  db.close();

  /* --- V: deletions a refused delete left behind before v0.0.16 --- */
  const dV=mk('mmwstaffV-');dirs.push(dV);db.init(dV);db.ensureDeviceId();
  {const a=db.login('admin','admin');
   db.createUser(a,{username:'anna',full_name:'Anna Reed',role:'admin',password:'anna-pw-v'});
   db.createUser(a,{username:'cara',full_name:'Cara Diaz',role:'admin',password:'cara-pw-v'});
   const s=db.collectSyncRows(5000);db.markSynced(s.mark);}
  db.close();
  const vStamp=new Date().toISOString()+'@laptop-on-0.0.15';
  {const h=raw(dV);const uid=(n)=>h.prepare('SELECT uid FROM users WHERE username=?').get(n).uid;out.vAnna=uid('anna');out.vCara=uid('cara');
   const t=h.prepare("INSERT INTO tombstones (uid,entity,event_uid,updated_at,synced_rev,created_at) VALUES (?,'user',NULL,?,?,?)");
   t.run(out.vAnna,vStamp,'sent',vStamp);   // Anna's, already sent to the server
   t.run(out.vCara,vStamp,null,vStamp);     // Cara's, made offline, never sent
   h.close();}
  db.init(dV);
  {const h=raw(dV);out.vTombs=h.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE entity='user'").get().n;h.close();
   const s=db.collectSyncRows(5000);const an=s.rows.find((r)=>r.uid===out.vAnna);
   out.vSend={anna:an?{undelete:!!an.undelete,deleted:an.deleted,newer:String(an.updated_at)>vStamp}:null,cara:s.rows.some((r)=>r.uid===out.vCara)};
   db.markSynced(s.mark);
   const again=db.collectSyncRows(5000);out.vSend.once=!again.rows.some((r)=>r.uid===out.vAnna);
   // The server's copy of her deletion, pulled again: older than her account now.
   const res=db.applyRemoteRows([{entity:'user',uid:out.vAnna,event_uid:null,patient_uid:null,deleted:1,updated_at:vStamp,data:{}}]);
   out.vAfter={deleted:res.deleted,anna:!!db.login('anna','anna-pw-v'),cara:!!db.login('cara','cara-pw-v')};}
  db.close();

  /* --- F: deletions from a laptop still on 0.0.15, beside updated ones --- */
  const f1=mk('mmwstaffF1-'),f2=mk('mmwstaffF2-');dirs.push(f1,f2);
  db.init(f1);db.ensureDeviceId();
  const fIds={};let fRows;
  {let a=db.login('admin','admin');db.updateUser(a,a.id,{password:'clinic-pw-f'});a=db.login('admin','clinic-pw-f');fIds.admin=a.id;
   fIds.anna=db.createUser(a,{username:'anna',full_name:'Anna Reed',role:'admin',password:'anna-pw-f'}).id;
   fIds.cara=db.createUser(a,{username:'cara',full_name:'Cara Diaz',role:'admin',password:'cara-pw-f'}).id;
   fIds.ben=db.createUser(a,{username:'ben',full_name:'Ben Ortiz',role:'doctor',password:'ben-pw-f'}).id;
   fRows=db.collectSyncRows(5000);db.markSynced(fRows.mark);}
  db.close();
  const fUid={};{const h=raw(f1);for(const n of ['anna','cara','ben'])fUid[n]=h.prepare('SELECT u.uid, e.uid AS ev FROM users u LEFT JOIN events e ON e.id=u.event_id WHERE u.username=?').get(n);h.close();}
  db.init(f2);db.ensureDeviceId();db.applyRemoteRows(fRows.rows);
  db.login('anna','anna-pw-f');db.login('ben','ben-pw-f');   // Cara never signs in here
  // What 0.0.15 sends for a Delete, refused or not: a deletion with nothing in it.
  const oldDel=(n)=>({entity:'user',uid:fUid[n].uid,event_uid:fUid[n].ev||null,patient_uid:null,deleted:1,updated_at:new Date().toISOString()+'@laptop-on-0.0.15',data:{}});
  const fR1=db.applyRemoteRows([oldDel('anna'),oldDel('cara'),oldDel('ben')]);
  {const h=raw(f2);const has=(n)=>!!h.prepare('SELECT 1 FROM users WHERE username=?').get(n);
   out.fOld={deleted:fR1.deleted,deferred:fR1.deferred,heldAnna:fR1.deferredRows.length===1&&fR1.deferredRows[0].uid===fUid.anna.uid,
     anna:has('anna'),cara:has('cara'),ben:has('ben'),annaIn:!!db.login('anna','anna-pw-f')};h.close();}
  db.close();
  // On an updated laptop: Delete on Anna, carried out there.
  db.init(f1);
  {const a=db.login('admin','clinic-pw-f');db.deleteUser(a,fIds.anna);}
  const fDel=db.collectSyncRows(5000);db.markSynced(fDel.mark);
  {const t=fDel.rows.find((r)=>r.uid===fUid.anna.uid);out.fWire=t?JSON.stringify(t.data):null;}
  db.close();
  db.init(f2);
  const fR2=db.applyRemoteRows(fDel.rows.concat(fR1.deferredRows));
  {const h=raw(f2);out.fNew={deleted:fR2.deleted,deferred:fR2.deferred,anna:!!h.prepare("SELECT 1 FROM users WHERE username='anna'").get(),
     signIns:h.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='login' AND user_name='Anna Reed' AND user_id IS NULL").get().n,
     tomb:h.prepare('SELECT updated_at, carried_out FROM tombstones WHERE uid=?').get(fUid.anna.uid)};
   out.fNew.newest=!!out.fNew.tomb&&String(out.fNew.tomb.updated_at)===String(fDel.rows.find((r)=>r.uid===fUid.anna.uid).updated_at);h.close();}
  // Moved to a new server, this laptop passes on only deletions it made
  // itself (see markAllUnsent). These three it only received from the old
  // server, so none goes to the new one: a trial server's deletions must not
  // delete the clinic's real records.
  db.markAllUnsent();
  {const s=db.collectSyncRows(5000);const d=(n)=>{const r=s.rows.find((x)=>x.uid===fUid[n].uid&&x.deleted);return r?JSON.stringify(r.data):null;};
   out.fRelay={anna:d('anna'),cara:d('cara'),ben:d('ben')};}
  db.close();
}catch(e){out.crash=String((e&&e.stack)||e);}
try{db.close();}catch(_){}
for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});
process.stdout.write('@@S@@'+JSON.stringify(out));
