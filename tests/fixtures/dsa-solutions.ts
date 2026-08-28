import type { DSALanguage, FoundationDSAId } from '@/lib/learning/dsa-foundations'

// Independent, deliberately straightforward reference implementations used
// only by tests. Never shipped as answers to the learner/VM in the product.
export const dsaSolutions: Record<FoundationDSAId, Record<DSALanguage, string>> = {
  'dsa-python-two-sum': {
    JavaScript: 'export function solve({nums,target}) { for(let i=0;i<nums.length;i++) for(let j=i+1;j<nums.length;j++) if(nums[i]+nums[j]===target)return[i,j];return[]; }',
    TypeScript: 'export function solve({nums,target}:{nums:number[];target:number}):number[] { for(let i=0;i<nums.length;i++) for(let j=i+1;j<nums.length;j++) if(nums[i]+nums[j]===target)return[i,j];return[]; }',
    Python: 'def solve(value):\n    nums,target=value["nums"],value["target"]\n    for i in range(len(nums)):\n        for j in range(i+1,len(nums)):\n            if nums[i]+nums[j]==target: return [i,j]\n    return []\n',
    Java: 'public class Main { public static int[] solve(int[] nums,int target) { for(int i=0;i<nums.length;i++)for(int j=i+1;j<nums.length;j++)if(nums[i]+nums[j]==target)return new int[]{i,j}; return new int[]{}; } }',
    'C++': '#include <vector>\nusing namespace std;\nvector<int> solve(const vector<int>& nums,int target){for(int i=0;i<(int)nums.size();i++)for(int j=i+1;j<(int)nums.size();j++)if(nums[i]+nums[j]==target)return {i,j};return {};}\n',
  },
  'dsa-python-valid-parentheses': {
    JavaScript: 'export function solve(value) {const s=[],pairs={")":"(","]":"[","}":"{"};for(const c of value){if("([{ ".trim().includes(c))s.push(c);else if(s.pop()!==pairs[c])return false;}return !s.length;}',
    TypeScript: 'export function solve(value:string):boolean {const s:string[]=[],pairs:Record<string,string>={")":"(","]":"[","}":"{"};for(const c of value){if("([{ ".trim().includes(c))s.push(c);else if(s.pop()!==pairs[c])return false;}return !s.length;}',
    Python: 'def solve(value):\n    stack=[]\n    pairs={")":"(","]":"[","}":"{"}\n    for c in value:\n        if c in "([{": stack.append(c)\n        elif not stack or stack.pop()!=pairs[c]: return False\n    return len(stack)==0\n',
    Java: 'public class Main { public static boolean solve(String value) { java.util.Stack<Character> s=new java.util.Stack<>(); String open="([{",close=")]}"; for(char c:value.toCharArray()){if(open.indexOf(c)>=0)s.push(c);else if(s.empty()||s.pop()!=open.charAt(close.indexOf(c)))return false;}return s.empty();} }',
    'C++': '#include <string>\n#include <vector>\nusing namespace std;\nbool solve(const string& value){vector<char>s;string a="([{",b=")]}";for(char c:value){if(a.find(c)!=string::npos)s.push_back(c);else{if(s.empty()||s.back()!=a[b.find(c)])return false;s.pop_back();}}return s.empty();}\n',
  },
  'dsa-python-binary-search': {
    JavaScript: 'export function solve({nums,target}) { return nums.indexOf(target); }',
    TypeScript: 'export function solve({nums,target}:{nums:number[];target:number}):number { return nums.indexOf(target); }',
    Python: 'def solve(value):\n    try: return value["nums"].index(value["target"])\n    except ValueError: return -1\n',
    Java: 'public class Main {public static int solve(int[] nums,int target){for(int i=0;i<nums.length;i++)if(nums[i]==target)return i;return -1;}}',
    'C++': '#include <vector>\nusing namespace std;\nint solve(const vector<int>& nums,int target){for(int i=0;i<(int)nums.size();i++)if(nums[i]==target)return i;return -1;}\n',
  },
}
