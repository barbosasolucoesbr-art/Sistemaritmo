const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(__dirname + '/data.js', 'utf8');
const defaults = { waterGoal: 2500, medications: [] };
const day = '2026-11-16';
const key = 'day:' + day;
const plain = value => JSON.parse(JSON.stringify(value));
function disk() {
  const values = new Map();
  return { getItem: k => values.get(k) || null, setItem(k,v) { values.set(k,v); } };
}
function server() {
  return { rows: new Map(), fail: false, beforeSave: null, set(user, key, data, revision=1) {
    this.rows.set(user+'|'+key,{user_id:user,record_key:key,data,deleted:data===null,revision,updated_at:new Date().toISOString()});
  }};
}
async function runtime({ storage=disk(), cloud=server(), user=null, online=true, recovery=false }={}) {
  let current = user ? { user: { id:user } } : null, onAuth;
  const timers = new Map(); let id = 0;
  const client = {
    auth: {
      async getSession() { if(recovery) onAuth('PASSWORD_RECOVERY',current); return {data:{session:current}}; },
      onAuthStateChange(fn) { onAuth=fn; },
      async signOut() { current=null; onAuth('SIGNED_OUT',null); return {}; }
    },
    async rpc(name,args) {
      const owner = current.user.id;
      if (cloud.beforeSave) await cloud.beforeSave();
      if(cloud.fail) return {error:{message:'Network request failed'}};
      const old=cloud.rows.get(owner+'|'+args.p_key);
      if ((old?.revision||0)!==args.p_expected_revision) return {data:{ok:false,record:old?structuredClone(old):null}};
      cloud.set(owner,args.p_key,args.p_deleted?null:structuredClone(args.p_data),(old?.revision||0)+1);
      return {data:{ok:true,record:structuredClone(cloud.rows.get(owner+'|'+args.p_key))}};
    },
    from() {
      let who;
      const q={ select(){return q;},eq(field,value){who=value;return q;},order(){return q;},async range(a,b){
        if(cloud.fail) return {error:{message:'Network request failed'}};
        return {data:structuredClone([...cloud.rows.values()].filter(r=>r.user_id===who).sort((a,b)=>a.record_key.localeCompare(b.record_key)).slice(a,b+1))};
      }}; return q;
    }
  };
  const navigator={onLine:online};
  const window={supabase:{createClient(){return client;}},addEventListener(){}};
  vm.runInNewContext(source,{window,navigator,document:{hidden:false,addEventListener(){}},localStorage:storage,
    structuredClone,crypto:{randomUUID},console,Date,Error,
    setTimeout(fn,delay){timers.set(++id,{fn,delay});return id;},clearTimeout(i){timers.delete(i);},setInterval(){return 1;}});
  const store=window.RitmoStore; await store.init(defaults);
  return { store,storage,cloud,navigator,async login(who){current={user:{id:who}};onAuth('SIGNED_IN',current);},
    async flushAuth(){for(const [id,t] of [...timers])if(t.delay===0){timers.delete(id);await t.fn();}} };
}

test('local records survive reload without an account or internet',async()=>{
  const r=await runtime({online:false}); await r.store.put(key,{date:day,water:400});
  const reload=await runtime({storage:r.storage,online:false});
  assert.equal((await reload.store.snapshot()).days[day].water,400);
  assert.equal(reload.store.state.owner,'guest');
});
test('legacy fallback migrates once, preserving original and empty medication defaults',async()=>{
  const storage=disk();storage.setItem('ritmo-fallback',JSON.stringify({days:{[day]:{date:day,water:200}},settings:defaults}));
  let r=await runtime({storage});assert.equal((await r.store.snapshot()).days[day].water,200);
  await r.store.put(key,{date:day,water:600});r=await runtime({storage});
  assert.equal((await r.store.snapshot()).days[day].water,600);
  assert.equal(JSON.parse(storage.getItem('ritmo-fallback')).days[day].water,200);
  assert.deepEqual(plain((await r.store.snapshot()).settings.medications),[]);
});
test('failed local storage never reports a write as saved',async()=>{
  const r=await runtime();r.storage.setItem=()=>{throw Error('Quota exceeded');};
  await assert.rejects(r.store.put(key,{water:400}),/Quota/);
  assert.equal((await r.store.snapshot()).days[day],undefined);
});
test('offline and failed uploads stay durable, then synchronize',async()=>{
  const r=await runtime({user:'A',online:false});await r.store.put(key,{water:500});await r.store.sync();
  assert.equal(r.cloud.rows.size,0);assert.equal(r.store.state.status,'offline');
  r.navigator.onLine=true;r.cloud.fail=true;await r.store.sync();assert.equal((await r.store.snapshot()).pending,1);
  const reload=await runtime({storage:r.storage,cloud:r.cloud,user:'A'});reload.cloud.fail=false;await reload.store.sync();
  assert.equal(reload.cloud.rows.get('A|'+key).data.water,500);assert.equal((await reload.store.snapshot()).pending,0);
});
test('different accounts never share their local records',async()=>{
  const storage=disk(),cloud=server();const a=await runtime({storage,cloud,user:'A'});
  await a.store.put(key,{water:250});await a.store.sync();
  const b=await runtime({storage,cloud,user:'B'});await b.store.sync();assert.deepEqual(plain((await b.store.snapshot()).days),{});
  await b.store.put(key,{water:700});await b.store.sync();assert.equal(cloud.rows.get('A|'+key).data.water,250);
  assert.equal(cloud.rows.get('B|'+key).data.water,700);
});
test('guest import belongs to selected account and disappears after sign-out',async()=>{
  const r=await runtime();await r.store.put(key,{water:300});await r.login('A');await r.store.importGuest();await r.store.sync();
  assert.equal((await r.store.snapshot()).days[day].water,300);assert.equal(await r.store.hasGuestData(),false);
  await r.store.signOut();assert.deepEqual(plain((await r.store.snapshot()).days),{});
  await r.store.put(key,{water:100});assert.equal(await r.store.hasGuestData(),true);
  assert.equal(r.cloud.rows.get('A|'+key).data.water,300);
});
test('non-overlapping changes from two devices are merged',async()=>{
  const cloud=server();cloud.set('A',key,{water:200,habits:{walk:false}});
  const a=await runtime({cloud,user:'A'}),b=await runtime({cloud,user:'A'});await a.store.sync();await b.store.sync();
  await a.store.put(key,{water:400,habits:{walk:false}});await b.store.put(key,{water:200,habits:{walk:true}});
  await a.store.sync();await b.store.sync();await b.store.sync();
  assert.deepEqual(plain(cloud.rows.get('A|'+key).data),{water:400,habits:{walk:true}});
});
test('same-field conflict requires an explicit choice and retains both versions',async()=>{
  const cloud=server();cloud.set('A',key,{water:100});
  const a=await runtime({cloud,user:'A'}),b=await runtime({cloud,user:'A'});await a.store.sync();await b.store.sync();
  await a.store.put(key,{water:200});await a.store.sync();await b.store.put(key,{water:400});await b.store.sync();
  const s=await b.store.snapshot();assert.equal(s.conflicts.length,1);assert.equal(s.days[day].water,400);
  assert.equal(s.conflicts[0].conflict.remote.data.water,200);
  await b.store.resolveConflict(key,true);await b.store.sync();assert.equal(cloud.rows.get('A|'+key).data.water,400);
});
test('editing during an upload preserves the new edit for the next upload',async()=>{
  const r=await runtime({user:'A'});await r.store.put(key,{water:100});
  let release;const gate=new Promise(resolve=>release=resolve);let started;const begun=new Promise(resolve=>started=resolve);
  r.cloud.beforeSave=async()=>{started();await gate;};const upload=r.store.sync();await begun;
  await r.store.put(key,{water:500});release();await upload;
  assert.equal((await r.store.snapshot()).days[day].water,500);assert.equal((await r.store.snapshot()).pending,1);
  r.cloud.beforeSave=null;await r.store.sync();assert.equal(r.cloud.rows.get('A|'+key).data.water,500);
});
test('replacement pulls unseen cloud records before marking deleted records',async()=>{
  const cloud=server();cloud.set('A','day:2026-11-15',{water:200});
  const r=await runtime({cloud,user:'A'});await r.store.importAll({days:{[day]:{water:600}},settings:defaults});await r.store.sync();
  assert.equal(cloud.rows.get('A|day:2026-11-15').deleted,true);
  assert.equal(cloud.rows.get('A|'+key).data.water,600);
  const reload=await runtime({cloud,user:'A'});await reload.store.sync();assert.equal((await reload.store.snapshot()).days['2026-11-15'],undefined);
});
test('offline replacement of a cloud account is refused without changing records',async()=>{
  const r=await runtime({user:'A',online:false});await r.store.put(key,{water:300});
  await assert.rejects(r.store.importAll({days:{},settings:defaults}),/internet/);
  assert.equal((await r.store.snapshot()).days[day].water,300);
});
test('three-way merge detects deletion conflicts and compares objects independent of key order',async()=>{
  const {store}=await runtime();
  assert.equal(store.merge({a:1,b:2},{b:2,a:1},{a:2,b:2}).value.a,2);
  assert.equal(store.merge({water:1},null,{water:2}).conflict,true);
});
test('a password recovery event during initialization reaches the app after it subscribes',async()=>{
  const r=await runtime({user:'A',recovery:true});await r.flushAuth();
  const events=[];r.store.subscribe(e=>events.push(e.type));await r.flushAuth();
  assert.ok(events.includes('recovery'));
});
