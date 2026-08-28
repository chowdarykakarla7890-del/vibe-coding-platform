import { compiledRunner, debugLesson } from '../practice/shared'

const command = { executable: 'python3', args: ['check.py'] }
const javaFiles = (source: string, checks: string) => [
  { path: 'Main.java', content: source },
  { path: 'LessonTest.java', content: `import java.util.*;\npublic class LessonTest {\n  static void equal(Object actual,Object expected){if(!Objects.equals(actual,expected))throw new AssertionError("Expected "+expected+", received "+actual);}\n  public static void main(String[] args){\n${checks}\n    System.out.println("Debug regression checks passed");\n  }\n}\n` }, compiledRunner('Java'),
]
const cppFiles = (source: string, checks: string) => [
  { path: 'main.hpp', content: source },
  { path: 'lesson_test.cpp', content: `#include "main.hpp"\n#include <cassert>\n#include <iostream>\n#include <limits>\nint main(){\n${checks}\n  std::cout << "Debug regression checks passed\\n";\n}\n` }, compiledRunner('C++'),
]
export const javaDebug = [
  debugLesson({ track: 'java', stage: 'state-bug', title: 'Isolate two shopping carts',
    summary: 'Adding an item to one cart changes another cart. Identify the wrong lifetime of the collection.',
    concepts: ['debugging', 'static fields', 'object ownership'],
    explanation: 'A static field belongs to the class rather than one instance. That is useful for shared constants, but a mutable collection representing one cart must belong to that cart. The outward-facing list can still be a defensive immutable copy.',
    instructions: ['Repair Main, the shopping-cart class in Main.java. Each new instance starts empty. add(String) appends one item to that instance only; duplicates are allowed. items() returns an immutable snapshot in insertion order.', 'An earlier items() snapshot must not change after later adds. Keep add and items signatures and the defensive-copy behavior. Inputs are non-null strings.'],
    hints: ['Construct two Main instances in the same process.', 'Which field modifier makes both instances use one collection?', 'Do not remove the copy in items() while fixing ownership.'],
    reflectionQuestions: ['When would a static collection be appropriate instead?', 'Why is independent instance state different from an immutable returned snapshot?'],
    examples: [{ input: 'First cart adds "pen"; inspect a second new cart', output: 'Second cart remains empty' }],
    files: javaFiles(`import java.util.*;\npublic class Main {\n  private static final List<String> entries = new ArrayList<>();\n  public void add(String item) { entries.add(item); }\n  public List<String> items() { return List.copyOf(entries); }\n}\n`, `    var first = new Main();\n    equal(first.items(), List.of());\n    first.add("pen");\n    var saved = first.items();\n    var second = new Main();\n    equal(second.items(), List.of());\n    second.add("book");\n    equal(first.items(), List.of("pen"));\n    first.add("pen");\n    equal(first.items(), List.of("pen","pen"));\n    equal(saved, List.of("pen"));\n    try { saved.add("bad"); throw new AssertionError("Snapshot was mutable"); } catch(UnsupportedOperationException expected) {}`), command,
    quality: 'Makes cart storage instance-owned while retaining immutable snapshots',
  }),
  debugLesson({ track: 'java', stage: 'edge-cases', title: 'Keep a large ledger total exact',
    summary: 'Small sums work but large balances wrap negative. Locate where widening happens too late.',
    concepts: ['debugging', 'integer overflow', 'numeric promotion'],
    explanation: 'Returning long does not retroactively widen arithmetic already performed as int. Overflow occurs at the operation, so the accumulator must be wide before addition. A boundary test can distinguish storage width from return type.',
    instructions: ['Repair static long total(int[] amounts). Return the exact signed sum of all input integers, including negative adjustments. Empty arrays return 0L, and input is not mutated.', 'Arrays have at most 100,000 elements, so the result fits long even at int extremes. Do not clamp, wrap, discard negative values, or convert to floating point.'],
    hints: ['Inspect the type of the accumulator, not only the method return type.', 'What is Integer.MAX_VALUE + 1 when evaluated as int?', 'Promote before each addition by choosing an appropriate accumulator type.'],
    reflectionQuestions: ['Why would casting only the final result fail?', 'How can positive and negative boundary cases reveal different wraparound symptoms?'],
    examples: [{ input: 'total(new int[]{Integer.MAX_VALUE,1})', output: '2147483648L' }],
    files: javaFiles(`public class Main {\n  public static long total(int[] amounts) {\n    int sum = 0;\n    for (int amount : amounts) sum += amount;\n    return sum;\n  }\n}\n`, `    equal(Main.total(new int[]{}), 0L);\n    equal(Main.total(new int[]{10,-3,5}), 12L);\n    equal(Main.total(new int[]{Integer.MAX_VALUE,1}), 2147483648L);\n    equal(Main.total(new int[]{Integer.MIN_VALUE,-1}), -2147483649L);\n    int[] values={Integer.MAX_VALUE,Integer.MAX_VALUE,Integer.MIN_VALUE};\n    int[] copy=values.clone();\n    equal(Main.total(values), 2147483646L);\n    if(!Arrays.equals(values,copy))throw new AssertionError("Input changed");`), command,
    quality: 'Widens the accumulator before arithmetic and preserves exact signed sums',
  }),
]

export const cppDebug = [
  debugLesson({ track: 'cpp', stage: 'state-bug', title: 'Remove every completed task',
    summary: 'Removing completed tasks skips neighbors. Trace how vector erasure changes the next index.',
    concepts: ['debugging', 'vector erasure', 'iteration'],
    explanation: 'Erasing a vector element shifts later elements left. Incrementing an index immediately afterward can skip the element that moved into the erased position. A consecutive-match test exposes the issue better than isolated matches.',
    instructions: ['Repair pending(const std::vector<Task>& tasks) in main.hpp. Return all tasks whose done is false, preserving their IDs, relative order and values. Leave the input unchanged.', 'IDs are unique positive integers; Task remains {int id; bool done}. Handle empty input, all-completed input, and adjacent completed tasks. Do not add main() to the header.'],
    hints: ['Track the index after erasing the first of two completed tasks.', 'Choose an iteration strategy that does not skip shifted elements.', 'A filter-copy or erase-remove pattern avoids manual index repair.'],
    reflectionQuestions: ['Why do isolated completed tasks hide the bug?', 'What invalidation rules matter when removing vector elements?'],
    examples: [{ input: 'pending({{1,true},{2,true},{3,false}})', output: '{{3,false}}' }],
    files: cppFiles(`#pragma once\n#include <vector>\nstruct Task { int id; bool done; };\ninline std::vector<Task> pending(const std::vector<Task>& tasks) {\n  auto result = tasks;\n  for (std::size_t i=0; i<result.size(); ++i) {\n    if (result[i].done) result.erase(result.begin()+i);\n  }\n  return result;\n}\n`, `  assert(pending({}).empty());\n  auto single=pending({{1,false},{2,true},{3,false}});\n  assert(single.size()==2 && single[0].id==1 && single[1].id==3);\n  const std::vector<Task> original={{1,true},{2,true},{3,false},{4,true},{5,true},{6,false}};\n  auto result=pending(original);\n  assert(result.size()==2 && result[0].id==3 && result[1].id==6);\n  assert(pending({{1,true},{2,true}}).empty());\n  assert(original.size()==6 && original[0].done && original[1].done);`), command,
    quality: 'Repairs iteration invalidation without changing order or mutating source tasks',
  }),
  debugLesson({ track: 'cpp', stage: 'edge-cases', title: 'Repair an even-sized median',
    summary: 'Odd medians work, but even lists lose fractions or overflow. Check the arithmetic before conversion.',
    concepts: ['debugging', 'numeric promotion', 'median'],
    explanation: 'Integer division discards fractional parts, and integer addition may overflow before the result is converted to double. Promote operands before averaging. Sorting a copy also keeps median calculation from changing the caller’s order.',
    instructions: ['Repair median(const std::vector<int>& values), returning std::optional<double>. Empty input returns std::nullopt; otherwise sort a copy, return the middle value for odd size, and the mean of the two middle values for even size.', 'Support the full int range, duplicates and negative values without signed overflow or integer truncation. Do not mutate input. Do not add a main() function.'],
    hints: ['Try the two-element input {1,2}.', 'Conversion after integer addition is too late for extreme values.', 'Convert operands before adding and dividing, keeping the odd/empty paths unchanged.'],
    reflectionQuestions: ['Which two bugs can the expression (a+b)/2 contain?', 'Why should an even median be allowed to be fractional or negative?'],
    examples: [{ input: 'median({2,1})', output: '1.5' }, { input: 'median({-1,0})', output: '-0.5' }],
    files: cppFiles(`#pragma once\n#include <algorithm>\n#include <optional>\n#include <vector>\ninline std::optional<double> median(const std::vector<int>& values) {\n  if (values.empty()) return std::nullopt;\n  auto sorted = values;\n  std::sort(sorted.begin(), sorted.end());\n  auto middle = sorted.size()/2;\n  if (sorted.size()%2) return sorted[middle];\n  return (sorted[middle-1] + sorted[middle])/2;\n}\n`, `  assert(!median({}).has_value());\n  assert(median({9,1,5}).value()==5.0);\n  assert(median({2,1}).value()==1.5);\n  assert(median({-1,0}).value()==-0.5);\n  const int high=std::numeric_limits<int>::max(), low=std::numeric_limits<int>::min();\n  assert(median({high,high}).value()==static_cast<double>(high));\n  assert(median({low,low}).value()==static_cast<double>(low));\n  const std::vector<int> original={4,1,3,2};\n  assert(median(original).value()==2.5);\n  assert((original==std::vector<int>{4,1,3,2}));`), command,
    quality: 'Promotes before arithmetic and preserves empty, odd and immutable-input behavior',
  }),
]
