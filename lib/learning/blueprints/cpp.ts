import { milestones, projectBlueprint } from './shared'
export const tasksSource=`#pragma once
#include <algorithm>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
struct Task { int id; int priority; bool done; std::string title; };
inline std::vector<Task> addTask(const std::vector<Task>& tasks,Task input) { throw std::invalid_argument("Complete the TODO: validate and append a pending task"); }
inline std::vector<Task> finishTask(const std::vector<Task>& tasks,int id) { throw std::invalid_argument("Complete the TODO: complete a known task"); }
inline std::optional<Task> nextTask(const std::vector<Task>& tasks) { throw std::invalid_argument("Complete the TODO: choose the next pending task"); }
inline std::string encode(const std::vector<Task>& tasks) { throw std::invalid_argument("Complete the TODO: encode a versioned document"); }
inline std::vector<Task> decode(const std::string& text) { throw std::invalid_argument("Complete the TODO: validate every restored row"); }
`
const main=`#include "tasks.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <cerrno>
#include <cstdlib>
#include <unistd.h>
int number(const std::string& text){std::size_t used=0;int value=std::stoi(text,&used);if(used!=text.size())throw std::invalid_argument("Invalid number");return value;}
void atomicSave(const std::string& path,const std::vector<Task>& tasks){
 const std::string data=encode(tasks);decode(data);
 std::string pattern=path+".tmp-XXXXXX";std::vector<char> name(pattern.begin(),pattern.end());name.push_back(0);
 int fd=mkstemp(name.data());if(fd<0)throw std::runtime_error("Cannot create temporary file");
 try{std::size_t offset=0;while(offset<data.size()){auto count=write(fd,data.data()+offset,data.size()-offset);if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("Write failed");offset+=static_cast<std::size_t>(count);}if(fsync(fd)!=0)throw std::runtime_error("Flush failed");close(fd);fd=-1;std::filesystem::rename(name.data(),path);}
 catch(...){if(fd>=0)close(fd);unlink(name.data());throw;}
}
int main(int argc,char** argv){
 try{
  if(argc<3)throw std::invalid_argument("Usage: tasks FILE add ID PRIORITY TITLE | done ID | list | next");
  std::string path=argv[1],command=argv[2];std::vector<Task> tasks;
  if(std::filesystem::exists(path)){if(std::filesystem::file_size(path)>1048576)throw std::invalid_argument("File too large");std::ifstream input(path);if(!input)throw std::runtime_error("Read failed");tasks=decode(std::string(std::istreambuf_iterator<char>(input),{}));}
  if(command=="add"&&argc==6){tasks=addTask(tasks,{number(argv[3]),number(argv[4]),false,argv[5]});atomicSave(path,tasks);}
  else if(command=="done"&&argc==4){tasks=finishTask(tasks,number(argv[3]));atomicSave(path,tasks);}
  else if(command=="next"&&argc==3){auto next=nextTask(tasks);std::cout<<(next?std::to_string(next->id):"none")<<'\\n';return 0;}
  else if(command!="list"||argc!=3)throw std::invalid_argument("Invalid command");
  for(const auto& task:tasks)std::cout<<task.id<<'\\t'<<task.priority<<'\\t'<<(task.done?1:0)<<'\\t'<<task.title<<'\\n';
  return 0;
 }catch(const std::exception& error){std::cerr<<"Error: "<<error.what()<<'\\n';return 2;}
}
`
const tests=`#include "src/tasks.hpp"
#include <iostream>
void check(bool ok){if(!ok)throw std::runtime_error("Assertion failed");}
template<class F>void invalid(F fn){try{fn();}catch(const std::invalid_argument&){return;}throw std::runtime_error("Expected invalid input");}
void M1(){std::vector<Task> old={{1,2,false,"Read"}};auto next=addTask(old,{2,1,false," Write "});check(old.size()==1&&next.size()==2&&next[1].title=="Write");invalid([&]{addTask(old,{1,1,false,"Duplicate"});});invalid([&]{addTask(old,{0,1,false,"Invalid"});});invalid([&]{addTask(old,{2,4,false,"Invalid"});});invalid([&]{addTask(old,{2,1,false,"bad\\ttitle"});});invalid([&]{addTask(old,{2,1,true,"Already done"});});}
void M2(){std::vector<Task> tasks={{8,3,false,"Later"},{2,1,false,"Second"},{1,1,false,"First"},{3,1,true,"Finished"}};check(nextTask(tasks)->id==1);auto done=finishTask(tasks,1);check(!tasks[2].done&&done[2].done);check(nextTask(done)->id==2);check(finishTask(done,1)[2].done);invalid([&]{finishTask(tasks,99);});check(!nextTask({}).has_value());}
void M3(){std::vector<Task> tasks={{1,2,false,"Read"},{2,1,true,"Write"}};auto text=encode(tasks);check(text=="CODETUTOR_TASKS_V1\\n1\\t2\\t0\\tRead\\n2\\t1\\t1\\tWrite\\n");auto restored=decode(text);check(restored.size()==2&&restored[1].done);check(decode("CODETUTOR_TASKS_V1\\n").empty());for(const auto& raw:{"","BAD\\n","CODETUTOR_TASKS_V1\\n1\\t2\\t9\\tBad\\n","CODETUTOR_TASKS_V1\\n1x\\t2\\t0\\tBad\\n","CODETUTOR_TASKS_V1\\n1\\t2\\t0\\tRead\\n1\\t1\\t0\\tAgain\\n"})invalid([&]{decode(raw);});}
void M4(){auto tasks=decode(encode({{1,1,true,"Completed"}}));check(!nextTask(tasks));check(tasks[0].title=="Completed");}
int main(int argc,char** argv){std::string stage=argc>1?argv[1]:"all";if(stage=="all"||stage=="M1")M1();if(stage=="all"||stage=="M2")M2();if(stage=="all"||stage=="M3")M3();if(stage=="all"||stage=="M4")M4();std::cout<<"PASS "<<stage<<'\\n';}
`
const runner=`from pathlib import Path
import subprocess,sys,tempfile
stage=sys.argv[1] if len(sys.argv)>1 else 'all'
if stage not in ['all','M1','M2','M3','M4']:raise SystemExit('Unknown milestone; use M1, M2, M3, M4 or all')
with tempfile.TemporaryDirectory(prefix='codetutor-tasks-') as directory:
    root=Path(directory)
    for source,name in [('checks.cpp','checks'),('src/main.cpp','tasks')]:
        subprocess.run(['g++','-std=c++17','-Wall','-Wextra',source,'-o',str(root/name)],check=True,timeout=30,cwd=Path(__file__).parent)
    subprocess.run([str(root/'checks'),stage],check=True,timeout=10)
    if stage in ['all','M4']:
        path=root/'tasks.tsv'
        def run(*args):return subprocess.run([str(root/'tasks'),str(path),*args],capture_output=True,text=True,timeout=5)
        added=run('add','7','1','Read chapters');assert added.returncode==0,added.stderr
        assert run('next').stdout.strip()=='7'
        assert run('done','7').returncode==0
        assert run('next').stdout.strip()=='none'
        assert '7\\t1\\t1\\tRead chapters' in run('list').stdout
        before=path.read_bytes();assert run('add','7','2','Duplicate').returncode==2;assert path.read_bytes()==before
        path.write_text('broken');assert run('done','7').returncode==2;assert path.read_text()=='broken'
        assert not list(root.glob('tasks.tsv.tmp-*'))
`
export const cppBlueprint=projectBlueprint({track:'cpp',title:'Terminal task engine',summary:'Build a task engine with immutable transitions, priority selection, strict versioned storage and an atomic-save CLI.',concepts:['C++','STL','serialization','file I/O','testing'],explanation:'Treat serialized data as untrusted input even in a local CLI. A pure task engine separates validation and ordering from file I/O. The supplied adapter uses a same-directory temporary file and rename; that protects against partial writes but is not a multi-process transaction or cloud database.',
 instructions:[
  'Implement src/tasks.hpp. Task IDs are unique integers 1–1000000, priority is 1–3 (1 highest), and titles are trimmed printable ASCII (1–80 characters, no tabs/newlines). At most 1,000 tasks. Invalid input throws std::invalid_argument.',
  'addTask requires done=false and returns a new vector preserving insertion order. finishTask marks a known ID complete, is idempotent, and rejects unknown IDs. Neither changes the caller’s vector. nextTask returns the pending task with smallest priority, then smallest ID, or std::nullopt.',
  'encode writes CODETUTOR_TASKS_V1 followed by newline and insertion-ordered rows id<TAB>priority<TAB>0-or-1<TAB>title<NEWLINE>. decode requires that header, exactly four fields per nonempty row, valid canonical decimal numeric fields, valid titles and unique IDs; malformed input rejects the whole document. A header-only document is empty; a final newline is optional when reading.',
  'Keep the provided src/main.cpp CLI. Compile with g++ -std=c++17 src/main.cpp -o /tmp/tasks, then use /tmp/tasks tasks.tsv add 7 1 "Read chapters", next, done 7, or list. Invalid commands or corrupt saved state exit 2 without overwriting the file.',
  'Retain atomic-save cleanup, check actual CLI processes as well as domain functions, and explain the remaining concurrency limit. Missing storage starts empty; an existing empty/corrupt file is an error, never a silent reset.',
 ],milestones:milestones([
  {title:'Build the task model',goal:'Validate new tasks and preserve existing state while appending.',acceptance:['Reject invalid titles, duplicate IDs and already completed new tasks.','Preserve insertion order and input vectors.']},
  {title:'Select and complete work',goal:'Implement deterministic priority selection and idempotent completion.',acceptance:['Resolve priority ties by numeric ID.','Exclude completed tasks and handle empty queues.']},
  {title:'Define the storage format',goal:'Round-trip a strict versioned representation without partial acceptance.',acceptance:['Reject malformed numeric fields and duplicate rows.','Preserve completed state and insertion order.']},
  {title:'Verify the persisted CLI',goal:'Exercise separate add/list/next/done processes and failure paths.',acceptance:['Task state survives process restarts.','Invalid operations preserve bytes and leave no temporary files.']},
 ],stage=>({executable:'python3',args:['check.py',stage]})),hints:['Use a validation helper shared by insertion and decoding.','Compare priority and ID as a pair without sorting the caller’s vector.','Parse numeric fields completely; stoi without checking the consumed length accepts trailing junk.'],reflectionQuestions:['Why does compile success not establish persistence correctness?', 'Which crash cases does temporary-file replacement cover, and which concurrent-write races remain?'],examples:[{input:'Pending tasks (id 2, priority 1), (id 1, priority 1)',output:'next returns ID 1'},{input:'Corrupt tasks.tsv then done 7',output:'Exit 2; original bytes preserved'}],files:[{path:'src/tasks.hpp',content:tasksSource},{path:'src/main.cpp',content:main},{path:'checks.cpp',content:tests},{path:'check.py',content:runner}],command:{executable:'python3',args:['check.py']},preparation:'Run python3 check.py. Fresh curated C++ project sandboxes prepare g++ before attachment. No third-party package installation or HTTP preview is needed.',
})
