import 'server-only'
import { dsaTypes, extendedSpecification, type ExtendedDSAId, type ExtendedDSAInput, type DSAInputValue, type DSAFieldType } from '@/lib/learning/dsa-extended'

// A line protocol keeps Java/C++ solutions focused on algorithms, not JSON
// parsing. Text contracts contain no newlines. Every array includes its size;
// nested/nullable arrays therefore preserve empty rows and null positions.
function encode(type: DSAFieldType, value: DSAInputValue): string {
  if(type==='text'||type==='integer')return `${value}\n`
  const values=value as (number|string|null|number[])[]
  return `${values.length}\n`+values.map(item=>type==='matrix' ? encode('integers',item as number[]) : `${item===null?'null':item}\n`).join('')
}

const javaReaders = `
  static java.io.BufferedReader in=new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
  static String text() throws Exception { return in.readLine(); }
  static int integer() throws Exception { return Integer.parseInt(text()); }
  static int[] integers() throws Exception { int[] a=new int[integer()]; for(int i=0;i<a.length;i++)a[i]=integer();return a; }
  static Integer[] nullableIntegers() throws Exception { Integer[] a=new Integer[integer()]; for(int i=0;i<a.length;i++){String s=text();a[i]=s.equals("null")?null:Integer.valueOf(s);}return a; }
  static String[] strings() throws Exception { String[] a=new String[integer()]; for(int i=0;i<a.length;i++)a[i]=text();return a; }
  static int[][] matrix() throws Exception { int[][] a=new int[integer()][]; for(int i=0;i<a.length;i++)a[i]=integers();return a; }
  static String json(Object v){ if(v==null)return "null"; if(!v.getClass().isArray())return v.toString(); StringBuilder s=new StringBuilder("["); for(int i=0;i<java.lang.reflect.Array.getLength(v);i++){if(i>0)s.append(',');s.append(json(java.lang.reflect.Array.get(v,i)));}return s.append(']').toString(); }
`
const cppReaders = `
#include <iostream>
#include <iomanip>
#include <optional>
#include <vector>
#include <string>
namespace harness {
std::string text(){std::string s;std::getline(std::cin,s);return s;}
int integer(){return std::stoi(text());}
std::vector<int> integers(){std::vector<int>a(integer());for(auto &v:a)v=integer();return a;}
std::vector<std::optional<int>> nullableIntegers(){std::vector<std::optional<int>>a(integer());for(auto &v:a){auto s=text();if(s!="null")v=std::stoi(s);}return a;}
std::vector<std::string> strings(){std::vector<std::string>a(integer());for(auto &v:a)v=text();return a;}
std::vector<std::vector<int>> matrix(){std::vector<std::vector<int>>a(integer());for(auto &v:a)v=integers();return a;}
void emit(int n){std::cout<<n;} void emit(double n){std::cout<<std::setprecision(17)<<n;} void emit(bool b){std::cout<<(b?"true":"false");}
template<class T>void emit(const std::vector<T>&a){std::cout<<'[';for(size_t i=0;i<a.size();i++){if(i)std::cout<<',';emit(a[i]);}std::cout<<']';}
}
`

export function extendedCompiledHarness(id: ExtendedDSAId, language: 'Java'|'C++', inputs: ExtendedDSAInput[]) {
  return compiledHarness(extendedSpecification(id).fields, language, inputs)
}

/** Fields are selected by a server registry, never received from a learner. */
export function compiledHarness(fields: {name: string; type: DSAFieldType}[], language: 'Java'|'C++', inputs: ExtendedDSAInput[]) {
  const spec={fields}, types=dsaTypes[language]
  const args=spec.fields.map(field=>field.name).join(',')
  return {
    inputs: inputs.map(input=>spec.fields.map(field=>encode(field.type,input[field.name])).join('')),
    file: language==='Java' ? {path:'Runner.java',content:`public class Runner {${javaReaders}\npublic static void main(String[] args) throws Exception {${spec.fields.map(f=>`${types[f.type]} ${f.name}=${f.type}();`).join('')}System.out.print(json(Main.solve(${args})));}}\n`}
      : {path:'runner.cpp',content:`${cppReaders}\n#include "main.cpp"\nint main(){${spec.fields.map(f=>`auto ${f.name}=harness::${f.type}();`).join('')}harness::emit(solve(${args}));}\n`},
  }
}
