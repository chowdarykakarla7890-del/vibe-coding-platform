import { milestones, projectBlueprint } from './shared'
export const lendingSource=`import java.util.*;
public class Main {
  public record Book(String id,String title) {}
  public record Loan(String bookId,String memberId,int dueDay) {}
  public static final class Library {
    private final Map<String,Book> books=new HashMap<>();
    private final Map<String,String> members=new HashMap<>();
    private final Map<String,Loan> loans=new HashMap<>();
    public void addBook(String id,String title) { throw new UnsupportedOperationException("Complete the TODO: register books"); }
    public void addMember(String id,String name) { throw new UnsupportedOperationException("Complete the TODO: register members"); }
    public Loan borrow(String bookId,String memberId,int day) { throw new UnsupportedOperationException("Complete the TODO: enforce lending rules"); }
    public Loan giveBack(String bookId) { throw new UnsupportedOperationException("Complete the TODO: return a borrowed book"); }
    public List<Loan> overdue(int day) { throw new UnsupportedOperationException("Complete the TODO: report overdue loans"); }
    public List<Loan> loansFor(String memberId) { throw new UnsupportedOperationException("Complete the TODO: return an immutable member report"); }
  }
  public static void main(String[] args) {
    Library library=new Library();library.addBook("algorithms","Algorithms");library.addMember("sam","Sam");
    System.out.println(library.borrow("algorithms","sam",10));
    System.out.println("Overdue on day 25: "+library.overdue(25));
    library.giveBack("algorithms");System.out.println("After return: "+library.loansFor("sam"));
  }
}
`
const test=`import java.util.*;
public class ProjectTest {
 static void check(boolean ok){if(!ok)throw new AssertionError("Contract failed");}
 static void invalid(Runnable fn){try{fn.run();}catch(IllegalArgumentException expected){return;}throw new AssertionError("Expected invalid input");}
 static void conflict(Runnable fn){try{fn.run();}catch(IllegalStateException expected){return;}throw new AssertionError("Expected lending conflict");}
 static Main.Library library(){Main.Library lib=new Main.Library();for(int i=1;i<=4;i++)lib.addBook("b"+i,"Book "+i);lib.addMember("m","Member");lib.addMember("n","Other");return lib;}
 static void M1(){Main.Library lib=library();invalid(()->lib.addBook("b1","Duplicate"));invalid(()->lib.addMember("m","Duplicate"));invalid(()->lib.addBook("bad id","Valid"));invalid(()->lib.addMember("x"," "));check(lib.loansFor("m").isEmpty());invalid(()->lib.loansFor("unknown"));}
 static void M2(){Main.Library lib=library();Main.Loan loan=lib.borrow("b1","m",7);check(loan.equals(new Main.Loan("b1","m",21)));conflict(()->lib.borrow("b1","n",8));lib.borrow("b2","m",8);lib.borrow("b3","m",9);conflict(()->lib.borrow("b4","m",10));check(lib.loansFor("m").size()==3);check(lib.loansFor("n").isEmpty());invalid(()->lib.borrow("missing","m",0));invalid(()->lib.borrow("b4","n",-1));invalid(()->lib.borrow("b4","n",1000001));check(lib.loansFor("n").isEmpty());}
 static void M3(){Main.Library lib=library();lib.borrow("b2","m",1);lib.borrow("b1","m",2);check(lib.overdue(15).isEmpty());check(lib.overdue(16).equals(List.of(new Main.Loan("b2","m",15))));check(lib.overdue(17).get(0).bookId().equals("b1"));check(lib.giveBack("b2").bookId().equals("b2"));conflict(()->lib.giveBack("b2"));check(lib.borrow("b2","n",20).dueDay()==34);invalid(()->lib.overdue(-1));}
 static void M4(){Main.Library lib=library();lib.borrow("b1","m",0);List<Main.Loan> snapshot=lib.loansFor("m");try{snapshot.clear();throw new AssertionError("Mutable report");}catch(UnsupportedOperationException expected){}lib.giveBack("b1");check(snapshot.size()==1);check(lib.loansFor("m").isEmpty());check(library().loansFor("m").isEmpty());Main.main(new String[0]);}
 public static void main(String[] args){String stage=args.length==0?"all":args[0];if(stage.equals("all")||stage.equals("M1"))M1();if(stage.equals("all")||stage.equals("M2"))M2();if(stage.equals("all")||stage.equals("M3"))M3();if(stage.equals("all")||stage.equals("M4"))M4();System.out.println("PASS "+stage);}
}
`
export const javaBlueprint=projectBlueprint({track:'java',title:'Library lending service',summary:'Model books, members and loans with enforceable borrowing policies, boundary-tested overdue reports and isolated service state.',concepts:['Java','OOP','collections','invariants','testing'],
 explanation:'A service owns its state and must preserve invariants on every operation. Validate prerequisites before mutating maps so rejected loans leave no partial changes. Immutable records and defensive report snapshots prevent callers from altering the service indirectly. Logical integer days make time rules deterministic.',
 instructions:[
  'Complete Main.Library. IDs match [a-zA-Z0-9_-]{1,40}; trimmed book titles/member names contain 1–80 characters. Register each book/member ID once. Null, malformed or unknown IDs and invalid dates throw IllegalArgumentException; duplicate registration also throws IllegalArgumentException.',
  'borrow requires a registered available book and member, at most three current loans for that member, and an integer day 0–1000000. Return a Loan with dueDay=day+14. Already borrowed books or reaching the loan limit throw IllegalStateException. Failed operations must not alter state.',
  'giveBack requires a registered currently borrowed book, removes its loan and returns that Loan. A known unborrowed book throws IllegalStateException. The returned book can immediately be borrowed again.',
  'overdue(day) includes only loans with dueDay < day, sorted by bookId using String order. loansFor(memberId) returns that member’s loans in the same order. Both return immutable snapshots; later service changes must not change old reports. Distinct Library instances never share state.',
  'Keep Main.main as a runnable example. This is an in-memory domain service, not an HTTP API or durable database. Explain how a real service would add persistence and coordinate concurrent requests in REFLECTION.md.',
 ],milestones:milestones([
  {title:'Register books and members',goal:'Establish validated identities and independent per-library state.',acceptance:['Reject malformed and duplicate registration.','Distinguish unknown members from empty loan reports.']},
  {title:'Protect lending invariants',goal:'Implement borrowing only after every precondition succeeds.',acceptance:['One active loan per book and at most three per member.','Failed borrowing leaves every member report unchanged.']},
  {title:'Return and report overdue loans',goal:'Make date boundaries and return behavior explicit.',acceptance:['A loan is not overdue on its due day.','Returned books can be reborrowed and no longer appear overdue.']},
  {title:'Expose safe service results',goal:'Protect internal state through immutable report snapshots and run the example.',acceptance:['Caller mutation and later service changes cannot alter a prior report.','Multiple Library instances are independent.']},
 ],stage=>({executable:'python3',args:['check.py',stage]})),hints:['Check all borrowing rules before inserting a loan.','Return List.copyOf of a newly sorted collection.','Records are immutable, but a list of records still needs protection.'],reflectionQuestions:['Why is validate-then-mutate important when borrowing can fail?', 'What persistence and concurrency controls would an HTTP lending service require?'],examples:[{input:'Borrow on day 10',output:'Due day 24; overdue starting day 25'},{input:'Member with three loans borrows another',output:'IllegalStateException; loan state unchanged'}],
 files:[{path:'Main.java',content:lendingSource},{path:'ProjectTest.java',content:test},{path:'check.py',content:"from pathlib import Path\nimport subprocess,sys,tempfile\nstage=sys.argv[1] if len(sys.argv)>1 else 'all'\nif stage not in ['all','M1','M2','M3','M4']:raise SystemExit('Unknown milestone; use M1, M2, M3, M4 or all')\nwith tempfile.TemporaryDirectory(prefix='codetutor-library-') as build:\n    subprocess.run(['javac','-d',build,'Main.java','ProjectTest.java'],check=True,timeout=30,cwd=Path(__file__).parent)\n    subprocess.run(['java','-cp',build,'ProjectTest',sys.argv[1] if len(sys.argv)>1 else 'all'],check=True,timeout=10)\n"}],command:{executable:'python3',args:['check.py']},preparation:'Run python3 check.py for all service checks, or java Main.java for the example. Fresh curated Java project sandboxes prepare the compiler before attachment. This project uses terminal output, not an HTTP preview.',
})
