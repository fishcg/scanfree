#!/bin/sh
# 与 ai-image 项目一致的入口约定：k8s 里以 args: ["start"] 启动
if [ "$1" != 'start' ]; then
   echo "sorry, '$1' is not a command"
   exit 1
fi
exec npm start
