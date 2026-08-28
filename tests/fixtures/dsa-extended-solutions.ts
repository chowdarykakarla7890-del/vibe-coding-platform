import { dsaTypes, extendedSpecification, type ExtendedDSAId } from '@/lib/learning/dsa-extended'
import type { DSALanguage } from '@/lib/learning/dsa-foundations'

// Test-only independent implementations. No fixture solution is imported by
// application code or transmitted alongside a learner submission.
const bodies: Record<ExtendedDSAId, { js: string; py: string; java: string; cpp: string }> = {
  'dsa-python-merge-intervals': {
    js: `const out=[];for(const p of intervals.slice().sort((a,b)=>a[0]-b[0])){if(out.length&&p[0]<=out.at(-1)[1])out.at(-1)[1]=Math.max(out.at(-1)[1],p[1]);else out.push(p.slice());}return out;`,
    py: `out=[]\nfor a,b in sorted(intervals):\n    if out and a<=out[-1][1]: out[-1][1]=max(out[-1][1],b)\n    else: out.append([a,b])\nreturn out`,
    java: `Arrays.sort(intervals,Comparator.comparingInt(a->a[0]));List<int[]> out=new ArrayList<>();for(int[] p:intervals){if(!out.isEmpty()&&p[0]<=out.get(out.size()-1)[1])out.get(out.size()-1)[1]=Math.max(out.get(out.size()-1)[1],p[1]);else out.add(p.clone());}return out.toArray(new int[0][]);`,
    cpp: `auto a=intervals;sort(a.begin(),a.end());vector<vector<int>>out;for(auto p:a){if(!out.empty()&&p[0]<=out.back()[1])out.back()[1]=max(out.back()[1],p[1]);else out.push_back(p);}return out;`,
  },
  'dsa-python-longest-substring': {
    js: `let left=0,best=0;const last=new Map();for(let i=0;i<text.length;i++){left=Math.max(left,(last.get(text[i])??-1)+1);last.set(text[i],i);best=Math.max(best,i-left+1);}return best;`,
    py: `last={}\nleft=best=0\nfor i,c in enumerate(text):\n    left=max(left,last.get(c,-1)+1)\n    last[c]=i\n    best=max(best,i-left+1)\nreturn best`,
    java: `int[] last=new int[128];Arrays.fill(last,-1);int left=0,best=0;for(int i=0;i<text.length();i++){char c=text.charAt(i);left=Math.max(left,last[c]+1);last[c]=i;best=Math.max(best,i-left+1);}return best;`,
    cpp: `vector<int>last(128,-1);int left=0,best=0;for(int i=0;i<(int)text.size();i++){left=max(left,last[text[i]]+1);last[text[i]]=i;best=max(best,i-left+1);}return best;`,
  },
  'dsa-python-tree-level-order': {
    js: `if(!tree.length||tree[0]===null)return[];const q=[[tree[0],0]],out=[];let pos=1;for(let i=0;i<q.length;i++){const [v,d]=q[i];(out[d]??=[]).push(v);for(let j=0;j<2&&pos<tree.length;j++){const child=tree[pos++];if(child!==null)q.push([child,d+1]);}}return out;`,
    py: `if not tree or tree[0] is None: return []\nq=[(tree[0],0)]\nout=[]\npos=1\nfor value,depth in q:\n    if depth==len(out): out.append([])\n    out[depth].append(value)\n    for _ in range(2):\n        if pos<len(tree):\n            child=tree[pos]\n            pos+=1\n            if child is not None: q.append((child,depth+1))\nreturn out`,
    java: `if(tree.length==0||tree[0]==null)return new int[0][];List<int[]>q=new ArrayList<>();q.add(new int[]{tree[0],0});List<List<Integer>>out=new ArrayList<>();int pos=1;for(int i=0;i<q.size();i++){int[] v=q.get(i);if(v[1]==out.size())out.add(new ArrayList<>());out.get(v[1]).add(v[0]);for(int j=0;j<2&&pos<tree.length;j++){Integer c=tree[pos++];if(c!=null)q.add(new int[]{c,v[1]+1});}}return out.stream().map(row->row.stream().mapToInt(Integer::intValue).toArray()).toArray(int[][]::new);`,
    cpp: `if(tree.empty()||!tree[0])return {};vector<pair<int,int>>q{{*tree[0],0}};vector<vector<int>>out;int pos=1;for(size_t i=0;i<q.size();i++){auto [v,d]=q[i];if(d==(int)out.size())out.push_back({});out[d].push_back(v);for(int j=0;j<2&&pos<(int)tree.size();j++){auto c=tree[pos++];if(c)q.push_back({*c,d+1});}}return out;`,
  },
  'dsa-python-number-islands': {
    js: `const seen=new Set();let count=0;for(let r=0;r<grid.length;r++)for(let c=0;c<grid[r].length;c++){if(grid[r][c]!=='1'||seen.has(r+','+c))continue;count++;const q=[[r,c]];seen.add(r+','+c);for(let i=0;i<q.length;i++){const[y,x]=q[i];for(const[a,b]of[[y+1,x],[y-1,x],[y,x+1],[y,x-1]])if(grid[a]?.[b]==='1'&&!seen.has(a+','+b)){seen.add(a+','+b);q.push([a,b]);}}}return count;`,
    py: `seen=set()\ncount=0\nfor r,row in enumerate(grid):\n    for c,cell in enumerate(row):\n        if cell!='1' or (r,c) in seen: continue\n        count+=1\n        q=[(r,c)]\n        seen.add((r,c))\n        for y,x in q:\n            for a,b in [(y+1,x),(y-1,x),(y,x+1),(y,x-1)]:\n                if 0<=a<len(grid) and 0<=b<len(row) and grid[a][b]=='1' and (a,b) not in seen:\n                    seen.add((a,b))\n                    q.append((a,b))\nreturn count`,
    java: `int h=grid.length,w=h==0?0:grid[0].length(),count=0;boolean[][]seen=new boolean[h][w];for(int r=0;r<h;r++)for(int c=0;c<w;c++)if(grid[r].charAt(c)=='1'&&!seen[r][c]){count++;ArrayDeque<int[]>q=new ArrayDeque<>();q.add(new int[]{r,c});seen[r][c]=true;while(!q.isEmpty()){int[]p=q.remove();int[][]dirs={{1,0},{-1,0},{0,1},{0,-1}};for(int[]d:dirs){int y=p[0]+d[0],x=p[1]+d[1];if(y>=0&&y<h&&x>=0&&x<w&&grid[y].charAt(x)=='1'&&!seen[y][x]){seen[y][x]=true;q.add(new int[]{y,x});}}}}return count;`,
    cpp: `int h=grid.size(),w=h?grid[0].size():0,count=0;vector<vector<bool>>seen(h,vector<bool>(w));for(int r=0;r<h;r++)for(int c=0;c<w;c++)if(grid[r][c]=='1'&&!seen[r][c]){count++;queue<pair<int,int>>q;q.push({r,c});seen[r][c]=true;while(!q.empty()){auto[y,x]=q.front();q.pop();for(auto[dy,dx]:vector<pair<int,int>>{{1,0},{-1,0},{0,1},{0,-1}}){int a=y+dy,b=x+dx;if(a>=0&&a<h&&b>=0&&b<w&&grid[a][b]=='1'&&!seen[a][b]){seen[a][b]=true;q.push({a,b});}}}}return count;`,
  },
  'dsa-python-coin-change': {
    js: `const q=[[0,0]],seen=new Set([0]);for(let i=0;i<q.length;i++){const[sum,n]=q[i];if(sum===amount)return n;for(const c of coins)if(sum+c<=amount&&!seen.has(sum+c)){seen.add(sum+c);q.push([sum+c,n+1]);}}return -1;`,
    py: `q=[(0,0)]\nseen={0}\nfor total,n in q:\n    if total==amount: return n\n    for c in coins:\n        if total+c<=amount and total+c not in seen:\n            seen.add(total+c)\n            q.append((total+c,n+1))\nreturn -1`,
    java: `ArrayDeque<int[]>q=new ArrayDeque<>();q.add(new int[]{0,0});boolean[]seen=new boolean[amount+1];seen[0]=true;while(!q.isEmpty()){int[]p=q.remove();if(p[0]==amount)return p[1];for(int c:coins)if(p[0]+c<=amount&&!seen[p[0]+c]){seen[p[0]+c]=true;q.add(new int[]{p[0]+c,p[1]+1});}}return -1;`,
    cpp: `queue<pair<int,int>>q;q.push({0,0});vector<bool>seen(amount+1);seen[0]=true;while(!q.empty()){auto[s,n]=q.front();q.pop();if(s==amount)return n;for(int c:coins)if(s+c<=amount&&!seen[s+c]){seen[s+c]=true;q.push({s+c,n+1});}}return -1;`,
  },
  'dsa-python-top-k': {
    js: `const distinct=[...new Set(nums)];return distinct.sort((a,b)=>nums.filter(x=>x===b).length-nums.filter(x=>x===a).length||a-b).slice(0,k);`,
    py: `return sorted(set(nums),key=lambda n:(-nums.count(n),n))[:k]`,
    java: `Map<Integer,Integer>freq=new HashMap<>();for(int n:nums)freq.merge(n,1,Integer::sum);return freq.keySet().stream().sorted((a,b)->freq.get(a).equals(freq.get(b))?Integer.compare(a,b):Integer.compare(freq.get(b),freq.get(a))).limit(k).mapToInt(Integer::intValue).toArray();`,
    cpp: `map<int,int>f;for(int n:nums)f[n]++;vector<int>a;for(auto p:f)a.push_back(p.first);sort(a.begin(),a.end(),[&](int x,int y){return f[x]==f[y]?x<y:f[x]>f[y];});if((int)a.size()>k)a.resize(k);return a;`,
  },
  'dsa-python-linked-cycle': {
    js: `let a=head,b=head;while(b!==-1&&next[b]!==-1){a=next[a];b=next[next[b]];if(a===b)return true;}return false;`,
    py: `a=b=head\nwhile b!=-1 and next[b]!=-1:\n    a=next[a]\n    b=next[next[b]]\n    if a==b: return True\nreturn False`,
    java: `int a=head,b=head;while(b!=-1&&next[b]!=-1){a=next[a];b=next[next[b]];if(a==b)return true;}return false;`,
    cpp: `int a=head,b=head;while(b!=-1&&next[b]!=-1){a=next[a];b=next[next[b]];if(a==b)return true;}return false;`,
  },
  'dsa-python-word-break': {
    js: `const memo=new Map();function f(i){if(i===text.length)return true;if(memo.has(i))return memo.get(i);const yes=words.some(w=>text.startsWith(w,i)&&f(i+w.length));memo.set(i,yes);return yes;}return f(0);`,
    py: `from functools import lru_cache\n@lru_cache(None)\ndef f(i):\n    return i==len(text) or any(text.startswith(w,i) and f(i+len(w)) for w in words)\nreturn f(0)`,
    java: `boolean[]dp=new boolean[text.length()+1];dp[0]=true;Set<String>dict=new HashSet<>(Arrays.asList(words));for(int end=1;end<=text.length();end++)for(int start=0;start<end;start++)if(dp[start]&&dict.contains(text.substring(start,end))){dp[end]=true;break;}return dp[text.length()];`,
    cpp: `vector<int>memo(text.size()+1,-1);function<bool(int)>f=[&](int i){if(i==(int)text.size())return true;if(memo[i]!=-1)return memo[i]==1;for(auto&w:words)if(text.compare(i,w.size(),w)==0&&f(i+w.size())){memo[i]=1;return true;}memo[i]=0;return false;};return f(0);`,
  },
  'dsa-python-course-schedule': {
    js: `const adj=Array.from({length:numCourses},()=>[]),state=Array(numCourses).fill(0);for(const[a,b]of prerequisites)adj[a].push(b);function dfs(n){if(state[n]===1)return false;if(state[n]===2)return true;state[n]=1;if(adj[n].some(x=>!dfs(x)))return false;state[n]=2;return true;}return state.every((_,i)=>dfs(i));`,
    py: `adj=[[] for _ in range(numCourses)]\nstate=[0]*numCourses\nfor a,b in prerequisites: adj[a].append(b)\ndef dfs(n):\n    if state[n]==1: return False\n    if state[n]==2: return True\n    state[n]=1\n    if not all(dfs(x) for x in adj[n]): return False\n    state[n]=2\n    return True\nreturn all(dfs(n) for n in range(numCourses))`,
    java: `int[]degree=new int[numCourses];List<List<Integer>>adj=new ArrayList<>();for(int i=0;i<numCourses;i++)adj.add(new ArrayList<>());for(int[]p:prerequisites){degree[p[0]]++;adj.get(p[1]).add(p[0]);}ArrayDeque<Integer>q=new ArrayDeque<>();for(int i=0;i<numCourses;i++)if(degree[i]==0)q.add(i);int n=0;while(!q.isEmpty()){int c=q.remove();n++;for(int d:adj.get(c))if(--degree[d]==0)q.add(d);}return n==numCourses;`,
    cpp: `vector<vector<int>>adj(numCourses);vector<int>state(numCourses);for(auto p:prerequisites)adj[p[0]].push_back(p[1]);function<bool(int)>f=[&](int n){if(state[n]==1)return false;if(state[n]==2)return true;state[n]=1;for(int x:adj[n])if(!f(x))return false;state[n]=2;return true;};for(int i=0;i<numCourses;i++)if(!f(i))return false;return true;`,
  },
  'dsa-python-lru-cache': {
    js: `const entries=[],out=[];for(const[kind,key,value]of operations){const at=entries.findIndex(p=>p[0]===key);if(kind===0){out.push(at<0?-1:entries[at][1]);if(at>=0)entries.push(entries.splice(at,1)[0]);}else{if(at>=0)entries.splice(at,1);entries.push([key,value]);if(entries.length>capacity)entries.shift();}}return out;`,
    py: `entries=[]\nout=[]\nfor op in operations:\n    kind,key=op[:2]\n    at=next((i for i,p in enumerate(entries) if p[0]==key),-1)\n    if kind==0:\n        out.append(-1 if at<0 else entries[at][1])\n        if at>=0: entries.append(entries.pop(at))\n    else:\n        if at>=0: entries.pop(at)\n        entries.append((key,op[2]))\n        if len(entries)>capacity: entries.pop(0)\nreturn out`,
    java: `LinkedHashMap<Integer,Integer>m=new LinkedHashMap<>(16,0.75f,true);List<Integer>out=new ArrayList<>();for(int[]op:operations){if(op[0]==0)out.add(m.getOrDefault(op[1],-1));else{m.put(op[1],op[2]);if(m.size()>capacity)m.remove(m.keySet().iterator().next());}}return out.stream().mapToInt(Integer::intValue).toArray();`,
    cpp: `vector<pair<int,int>>entries;vector<int>out;for(auto op:operations){auto it=find_if(entries.begin(),entries.end(),[&](auto p){return p.first==op[1];});if(op[0]==0){out.push_back(it==entries.end()?-1:it->second);if(it!=entries.end()){auto p=*it;entries.erase(it);entries.push_back(p);}}else{if(it!=entries.end())entries.erase(it);entries.push_back({op[1],op[2]});if((int)entries.size()>capacity)entries.erase(entries.begin());}}return out;`,
  },
  'dsa-python-median-stream': {
    js: `return nums.map((_,i)=>{const a=nums.slice(0,i+1).sort((a,b)=>a-b);return(a[Math.floor(i/2)]+a[Math.ceil(i/2)])/2;});`,
    py: `import statistics\nreturn [statistics.median(nums[:i+1]) for i in range(len(nums))]`,
    java: `double[]out=new double[nums.length];for(int i=0;i<nums.length;i++){int[]a=Arrays.copyOf(nums,i+1);Arrays.sort(a);out[i]=(a[i/2]+a[(i+1)/2])/2.0;}return out;`,
    cpp: `vector<double>out;for(size_t i=0;i<nums.size();i++){vector<int>a(nums.begin(),nums.begin()+i+1);sort(a.begin(),a.end());out.push_back((a[i/2]+a[(i+1)/2])/2.0);}return out;`,
  },
  'dsa-python-edit-distance': {
    js: `const d=Array.from({length:source.length+1},()=>Array(target.length+1).fill(0));for(let i=0;i<=source.length;i++)d[i][0]=i;for(let j=0;j<=target.length;j++)d[0][j]=j;for(let i=1;i<=source.length;i++)for(let j=1;j<=target.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(source[i-1]===target[j-1]?0:1));return d[source.length][target.length];`,
    py: `d=[[0]*(len(target)+1) for _ in range(len(source)+1)]\nfor i in range(len(source)+1): d[i][0]=i\nfor j in range(len(target)+1): d[0][j]=j\nfor i in range(1,len(source)+1):\n    for j in range(1,len(target)+1):\n        d[i][j]=min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(source[i-1]!=target[j-1]))\nreturn d[-1][-1]`,
    java: `int[][]d=new int[source.length()+1][target.length()+1];for(int i=0;i<=source.length();i++)d[i][0]=i;for(int j=0;j<=target.length();j++)d[0][j]=j;for(int i=1;i<=source.length();i++)for(int j=1;j<=target.length();j++)d[i][j]=Math.min(Math.min(d[i-1][j]+1,d[i][j-1]+1),d[i-1][j-1]+(source.charAt(i-1)==target.charAt(j-1)?0:1));return d[source.length()][target.length()];`,
    cpp: `vector<vector<int>>d(source.size()+1,vector<int>(target.size()+1));for(int i=0;i<=(int)source.size();i++)d[i][0]=i;for(int j=0;j<=(int)target.size();j++)d[0][j]=j;for(int i=1;i<=(int)source.size();i++)for(int j=1;j<=(int)target.size();j++)d[i][j]=min({d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(source[i-1]!=target[j-1])});return d[source.size()][target.size()];`,
  },
}

export function extendedSolution(id: ExtendedDSAId, language: DSALanguage) {
  const spec=extendedSpecification(id), code=bodies[id], types=dsaTypes[language]
  const names=spec.fields.map(f=>f.name)
  if(language==='Python') return `def solve(value):\n${names.map(n=>`    ${n}=value["${n}"]`).join('\n')}\n${code.py.split('\n').map(line=>'    '+line).join('\n')}\n`
  if(language==='Java') return `import java.util.*;\npublic class Main {public static ${types[spec.result]} solve(${spec.fields.map(f=>`${types[f.type]} ${f.name}`).join(',')}){${code.java}}}\n`
  if(language==='C++') return `#include <bits/stdc++.h>\nusing namespace std;\n${types[spec.result]} solve(${spec.fields.map(f=>f.type==='integer'?`int ${f.name}`:`const ${types[f.type]}& ${f.name}`).join(',')}){${code.cpp}}\n`
  return `export function solve(value${language==='TypeScript'?`: {${spec.fields.map(f=>`${f.name}:${types[f.type]}`).join(';')}}`:''}){const {${names.join(',')}}=value;${code.js}}\n`
}
