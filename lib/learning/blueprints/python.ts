import { milestones, projectBlueprint } from './shared'
export const plannerSource=`import argparse,json,os,sys,tempfile
from pathlib import Path

def add_task(tasks, task):
    raise NotImplementedError('Complete the TODO: validate and append a task')
def complete_task(tasks, task_id):
    raise NotImplementedError('Complete the TODO: mark a known task done')
def schedule(tasks, minutes):
    raise NotImplementedError('Complete the TODO: produce a bounded study plan')
def decode(raw):
    raise NotImplementedError('Complete the TODO: validate the saved document')

def load(path):
    return decode(path.read_text(encoding='utf8') if path.exists() else None)
def save(path,tasks):
    # Validate before touching the destination; replace from its own directory.
    payload=json.dumps({'version':1,'tasks':tasks},ensure_ascii=False)
    decode(payload)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf8',dir=path.parent,delete=False) as file:
            temporary=Path(file.name);file.write(payload);file.flush();os.fsync(file.fileno())
        os.replace(temporary,path)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)
def main():
    parser=argparse.ArgumentParser(description='Single-user local study planner')
    parser.add_argument('--file',type=Path,default=Path('planner.json'))
    sub=parser.add_subparsers(dest='command',required=True)
    add=sub.add_parser('add');add.add_argument('id');add.add_argument('title');add.add_argument('minutes',type=int);add.add_argument('due');add.add_argument('--priority',type=int,default=2)
    done=sub.add_parser('done');done.add_argument('id')
    sub.add_parser('list')
    plan=sub.add_parser('plan');plan.add_argument('--minutes',type=int,required=True)
    args=parser.parse_args()
    try:
        tasks=load(args.file)
        if args.command=='add':tasks=add_task(tasks,{'id':args.id,'title':args.title,'minutes':args.minutes,'due':args.due,'priority':args.priority,'done':False});save(args.file,tasks)
        elif args.command=='done':tasks=complete_task(tasks,args.id);save(args.file,tasks)
        print(json.dumps(schedule(tasks,args.minutes) if args.command=='plan' else tasks,ensure_ascii=False))
    except (ValueError,OSError) as error:
        print('Error: '+str(error),file=sys.stderr);return 2
    return 0
if __name__=='__main__':sys.exit(main())
`
const checks=`import copy,json,subprocess,sys,tempfile,unittest
from pathlib import Path
from src.main import add_task,complete_task,schedule,decode
TASK={'id':'a','title':'Arrays','minutes':30,'due':'2026-04-01','priority':2,'done':False}
class M1(unittest.TestCase):
 def test_validated_model(self):
  original=[dict(TASK)];before=copy.deepcopy(original)
  rows=add_task(original,{**TASK,'id':'b','title':' Trees '});self.assertEqual(rows[1]['title'],'Trees');self.assertEqual(original,before)
  self.assertTrue(complete_task(rows,'b')[1]['done']);self.assertFalse(rows[1]['done'])
  for task in [{**TASK,'minutes':True},{**TASK,'minutes':0},{**TASK,'minutes':481},{**TASK,'due':'2026-02-29'},{**TASK,'id':'bad id'},{**TASK,'priority':4},{**TASK,'title':' '}]:
   with self.assertRaises(ValueError):add_task([],task)
  with self.assertRaises(ValueError):add_task(original,TASK)
  with self.assertRaises(ValueError):complete_task(rows,'missing')
  full=[{**TASK,'id':str(i)} for i in range(500)]
  with self.assertRaises(ValueError):add_task(full,{**TASK,'id':'extra'})
  with self.assertRaises(ValueError):add_task([],{**TASK,'done':True})
  done=complete_task(original,'a');self.assertEqual(complete_task(done,'a'),done)
class M2(unittest.TestCase):
 def test_whole_task_schedule(self):
  rows=[{**TASK,'id':'big','minutes':60,'priority':1},{**TASK,'id':'later','minutes':20,'due':'2026-04-02'},{**TASK,'id':'small','minutes':20},{**TASK,'id':'done','done':True,'minutes':5}]
  before=copy.deepcopy(rows);self.assertEqual(schedule(rows,40),['small','later']);self.assertEqual(schedule(rows,0),[]);self.assertEqual(rows,before)
  self.assertEqual(schedule([{**TASK,'id':'b'},{**TASK,'id':'a'}],60),['a','b'])
  for minutes in [-1,1441,True,2.5]:
   with self.assertRaises(ValueError):schedule(rows,minutes)
class M3(unittest.TestCase):
 def test_document_validation(self):
  self.assertEqual(decode(None),[]);self.assertEqual(decode(json.dumps({'version':1,'tasks':[TASK]})),[TASK])
  for raw in ['bad','{}','null',json.dumps({'version':2,'tasks':[]}),json.dumps({'version':1,'tasks':[TASK,TASK]}),json.dumps({'version':1,'tasks':[{**TASK,'done':'false'}]})]:
   with self.assertRaises(ValueError):decode(raw)
class M4(unittest.TestCase):
 def test_real_cli_round_trip_and_invalid_file_preservation(self):
  script=Path(__file__).parent/'src/main.py'
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'planner.json'
   def run(*args):return subprocess.run([sys.executable,str(script),'--file',str(path),*args],capture_output=True,text=True,timeout=5)
   added=run('add','read','Read chapters','25','2026-04-01');self.assertEqual(added.returncode,0,added.stderr)
   self.assertEqual(json.loads(run('plan','--minutes','30').stdout),['read'])
   self.assertEqual(run('done','read').returncode,0);self.assertTrue(json.loads(run('list').stdout)[0]['done'])
   before=path.read_bytes();self.assertEqual(run('add','read','Duplicate','10','2026-04-01').returncode,2);self.assertEqual(path.read_bytes(),before)
   path.write_text('broken JSON');self.assertEqual(run('add','x','Safe title','10','2026-04-01').returncode,2);self.assertEqual(path.read_text(),'broken JSON')
   self.assertEqual(sorted(x.name for x in Path(root).iterdir()),['planner.json'])
if __name__=='__main__':unittest.main()
`
export const pythonBlueprint=projectBlueprint({track:'python',title:'Study planner CLI',summary:'Create a command-line study planner with deterministic scheduling, validation and atomic local JSON persistence.',concepts:['Python','CLI','validation','scheduling','file I/O'],
 explanation:'Separate task rules from command-line parsing and persistence. Greedy scheduling is a declared policy, not an optimal knapsack solver: sort by due date, priority and ID, then take whole tasks that fit. Validate every restored record before a mutation and replace saved files atomically to avoid half-written JSON.',
 instructions:[
  'Implement add_task, complete_task, schedule and decode in src/main.py. Tasks are {id,title,minutes,due,priority,done}; IDs match [a-zA-Z0-9_-]{1,40}, trimmed titles are 1–80 characters, minutes are integers 1–480 (not bool), due is a real YYYY-MM-DD date, priority is integer 1–3 (1 highest), and done is bool. Cap tasks at 500; invalid data raises ValueError.',
  'add_task requires a unique ID and done=False, returns a new list, and normalizes the title. complete_task returns new state with that ID done; repeating it is a no-op, unknown IDs raise. Neither function may mutate input tasks.',
  'schedule accepts a whole-minute budget 0–1440, excludes done tasks, orders due ascending then priority ascending then ID ascending, and greedily includes complete tasks that fit the remaining budget. Skip tasks that do not fit and continue. Return IDs in selected order; do not mutate tasks.',
  'decode(None) returns []; other input must be valid JSON {version:1,tasks:[...]}. Validate every field, unique IDs and the count cap; malformed input raises ValueError, never an empty fallback. Keep the supplied CLI and same-directory atomic save behavior.',
  'Use python3 src/main.py --file planner.json add read "Read chapters" 25 2026-04-01, then plan --minutes 30, done read, and list. This is single-user local persistence; it does not coordinate concurrent processes or provide cloud sync.',
 ],milestones:milestones([
  {title:'Model validated tasks',goal:'Implement immutable task creation and completion with explicit validation.',acceptance:['Reject invalid dates, booleans-as-integers and duplicate IDs.','Complete tasks without mutating prior state.']},
  {title:'Schedule a study session',goal:'Apply a deterministic whole-task scheduling policy with a fixed budget.',acceptance:['Skip an oversized task but still consider later tasks.','Handle ties, completed tasks and zero minutes.']},
  {title:'Read trusted local state',goal:'Validate the versioned document instead of accepting malformed JSON records.',acceptance:['Reject the entire invalid document.','Restore valid completed and pending tasks.']},
  {title:'Exercise persistence across commands',goal:'Run the real CLI in separate processes and preserve files after invalid input.',acceptance:['Add, plan, complete and list a persisted task.','Invalid commands and corrupt files do not overwrite prior bytes.']},
 ],stage=>({executable:'python3',args:['-m','unittest',`checks.${stage}`]})),
 hints:['Use datetime.date.fromisoformat plus exact ISO round-trip validation.','Sort a fresh list, then subtract minutes only when you include a task.','Share record validation between add_task and decode, while allowing done=True in restored records.'],reflectionQuestions:['Why does this greedy policy not guarantee maximum completed tasks?', 'What does atomic replacement protect, and what concurrent-write problem remains?'],examples:[{input:'Tasks 60, 20 and 20 minutes in priority order; budget 40',output:'Skip the 60-minute task, include both 20-minute tasks'},{input:'Malformed saved JSON followed by add',output:'Exit code 2; file bytes unchanged'}],
 files:[{path:'src/main.py',content:plannerSource},{path:'checks.py',content:checks}],command:{executable:'python3',args:['-m','unittest','checks']},preparation:'Run python3 -m unittest checks. No third-party dependencies are required. The command-line project uses the terminal, not an HTTP preview.',
})
