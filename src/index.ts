#!/usr/bin/env node

import * as fs from 'fs/promises';
import YAML from 'yaml';
import {
  intersection as _intersection,
  differenceWith as _differenceWith,
  escapeRegExp as _escapeRegExp,
  toPairs as _toPairs,
  fromPairs as _fromPairs,

} from 'lodash';
import { exit } from 'process';
import * as path from 'path';

const __root = process.cwd();

const ConfigFileNames = [
  '.dirlintrc.js',
  '.dirlintrc.json',
  '.dirlintrc.yml',
];

const noStarPathReg = /^\/([\w\.\-]+\/?)*$/;
const hasStarPathReg = /^\/([\w\.\-\*]+\/?)+$/;
const ruleKeyReg = /^\/[\w\.\-\*]+$/;
// 内部预留的匹配正则
const innerRegexpStr: any = {
  PascalCase: '(?:[A-Z][a-z]+)+',
  PascalCaseWithABB: '(?:[A-Z][a-z]*)+',
  camelCase: '[a-z]+(?:[A-Z][a-z]+)*',
  camelCaseWithABB: '[a-z]+(?:[A-Z][a-z]*)*',
}

function formatMatchHistory(isMatch: boolean, filePath: string, rule: any, mathMsg: string){
  return `[${isMatch?'success':'failed'}][filePath]:${filePath} ${mathMsg} [rule]:${rule.key} - {${rule.value}}${isMatch?'':'\n'}`;
}


function matchModelToRegexp(str: string,regA?: string, regB?: string): string{
  const regexpStr = _escapeRegExp(str).replaceAll("\\*\\*",regA||"([\\w\\.\\-]+\\/?)+").replaceAll("\\*",regB||"[\\w\\.\\-]+");
  return `^${regexpStr}$`;
}


fs.readdir("./").then((res)=>{
  const configFiles = _intersection(res, ConfigFileNames);
  if(configFiles.length === 0){
    throw new Error("没有找到配置文件");
  }
  // 取第一个
  const [configFile] = configFiles;
  let readConfigPromise;
  if(configFile.endsWith(".js")){
    readConfigPromise = import(configFile);
  } else if(configFile.endsWith(".json")){
    readConfigPromise = new Promise((resolve,reject)=>{
      fs.readFile(configFile, "utf-8").then(res=>{
        resolve(JSON.parse(res));
      }).catch(err=>{
        reject(err);
      })
    });
  } else if(configFile.endsWith(".yml")){
    readConfigPromise = new Promise((resolve,reject)=>{
      fs.readFile(configFile, "utf-8").then(res=>{
        resolve(YAML.parse(res));
      }).catch(err=>{
        reject(err);
      })
    });
  }
  readConfigPromise?.then(config=>{
    if(config?.exceptions && !Array.isArray(config?.exceptions)){
      throw new Error("exceptions must be array");
    }


    const exceptions = config?.exceptions?.map((item: string)=>{
      if(!hasStarPathReg.test(item)){
        throw new Error(`exceptions: ${item} is not allowed`);
      }


      return matchModelToRegexp(item);
      //_escapeRegExp(item).replaceAll("\\*\\*","([\\w\\.\\-]+\\/?)+").replaceAll("\\*","[\\w\\.\\-]+");
    }) || [];

    if(config?.rules){
      Object.keys(config?.rules).forEach(ruleDir=>{
        if(!noStarPathReg.test(ruleDir)){
          throw new Error(`ruleDir: ${ruleDir} is not allowed`);
        }

        dfsMathAsync(ruleDir,config.rules[ruleDir],exceptions);

      });



    }

  })

}).catch(err=>{
  console.error(err.message);
  exit(-1);
})

function dfsMathAsync(ruleDir: string, rootRule: any,exceptions: string[]){

  fs.readdir(path.join(__root,ruleDir)).then(fileNames=>{
    let files = fileNames.map(fileName=>{
      return {
        fileName,
        fullPath:path.posix.join(ruleDir, fileName)
      };
    });

    // 去除例外,包含上级目录的实际路径
    files = _differenceWith(files,exceptions,(file,regexp)=>new RegExp(regexp).test(file.fullPath));

    // 获取规则的key列表，并转换相应的正则(去掉开始的/，匹配文件名用),
    const rules = Object.keys(rootRule).map(key=>{
      if(!ruleKeyReg.test(key)){
        throw new Error(`rule: ${key} is not allowed`);
      }

      return {
        key,
        keyRegexp:matchModelToRegexp(key.slice(1)),
        //_escapeRegExp(key.slice(1)).replaceAll("\\*\\*","([\\w\\.\\-]+\\/?)+").replaceAll("\\*","[\\w\\.\\-]+"),
        value:rootRule[key]
      };
    });

    // **表示需要继承到下级的规则
    const extendRule = _fromPairs(_toPairs(rootRule).filter(([key,value])=>key.includes("**")));

    files.forEach(file=>{
      // 找到当前文件相匹配的规则列表
      const fileRules = rules.filter((rule=> new RegExp(rule.keyRegexp).test(file.fileName)));
      if(fileRules.length === 0){
        throw new Error(`file: ${file.fullPath} has not rule`);
      }

      // 读取文件的信息
      fs.stat(path.join(__root,file.fullPath)).then(stat=>{
        let matchResult = {
          status:false,
          matchHistory:''
        };
        // 遍历规则进行依次匹配
        for(let fileRule of fileRules){
          const ruleValue = fileRule.value;

          // 如果规则不是一个对象（对象或者数组），报错
          if(typeof ruleValue !== 'object'){
            throw new Error(`rule: ${fileRule.key} is not right rule`);
          }

          // 如果是一个数组，则验证
          if(Array.isArray(ruleValue)){

              // 不是文件
              if(ruleValue[0] === 'file' && !stat.isFile()){
                //throw new Error(`file: ${file.fullPath} is not a file`);
                matchResult.matchHistory += formatMatchHistory(false, file.fullPath, fileRule, 'is not a file');
                //`[failed][rule]: ${fileRule.key}:${ruleValue} [file]: ${file.fullPath} [msg]is not a file\n`;
                continue;
              }

              // 不是目录
              if(ruleValue[0] === 'dir' && !stat.isDirectory()){
                //throw new Error(`file: ${file.fullPath} is not a directory`);
                matchResult.matchHistory += formatMatchHistory(false, file.fullPath, fileRule, 'is not a directory');
                //`[failed][rule]: ${fileRule.key}:${ruleValue} [file]: ${file.fullPath} [msg]is not a directory\n`;
                continue;
              }

              if(ruleValue[1]){
                // 获取对应的正则
                const paramB: string = ruleValue[1].trim();
                const ruleRegexp = innerRegexpStr[paramB] || paramB ;

                // 按配置规则进行验证
                const regstr = matchModelToRegexp(fileRule.key.slice(1),ruleRegexp,ruleRegexp);
                //_escapeRegExp(fileRule.key.slice(1)).replaceAll("\\*\\*",ruleValue[1]).replaceAll("\\*",ruleValue[1]);
                if(!new RegExp(regstr).test(file.fileName)){
                  //throw new Error(`${file.fileName} is not match ${regstr}`);
                  matchResult.matchHistory += formatMatchHistory(false, file.fullPath, fileRule, 'is not match');
                  //`[failed][rule]: ${fileRule.key}:${ruleValue} [file]: ${file.fullPath} [msg]is not match\n`;
                  continue;
                }
              }
              matchResult = {
                status:true,
                matchHistory: formatMatchHistory(true, file.fullPath, fileRule, 'is match')
                //`[success][rule]: ${fileRule.key}:${ruleValue} [file]: ${file.fullPath} [msg]is match`
              };
              if(ruleValue[0] === 'dir' && stat.isDirectory() && Object.keys(extendRule).length>0){
                //是目录，且有继承的规则，还要继续遍历
                dfsMathAsync(file.fullPath,extendRule,exceptions);
              }
              break;

          } else if(stat.isDirectory()) {
            // 当前是一个目录，且rulevalue是一个对象，还需要递归
            matchResult = {
              status:true,
              matchHistory:formatMatchHistory(true, file.fullPath, fileRule, 'is match')
              //`[success][rule]: ${fileRule.key} [file]: ${file.fullPath} [msg]is match`
            };


            dfsMathAsync(file.fullPath,{
              ...extendRule,
              ...ruleValue
            },exceptions);

            break;
          } else {
            // 文件，但是rulevalue不是数组，则规则错误
            matchResult = {
              status:false,
              matchHistory:formatMatchHistory(false, file.fullPath, fileRule, 'is not a right rule')
              //`[success][rule]: ${fileRule.key} [file]: ${file.fullPath} [msg]is match`
            };
          }
        }

        if(!matchResult.status){
          throw new Error(matchResult.matchHistory);
        }
        console.log(matchResult.matchHistory);

      });



    })


  })
}
