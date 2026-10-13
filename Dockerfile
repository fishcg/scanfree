# 全民扫描 —— 运行镜像
#
# 与 ai-image 项目同一套做法：用集群内网 registry 里的 node 基础镜像，
# 打出来的镜像推到 172.24.173.77:30500，再由 k8s 拉取。
#
# 这个镜像**不需要 npm install**：服务端只用 Node 内置模块（零依赖），
# 所以构建时不用连 npm 源，也就不会卡在代理和网络上。
FROM 172.24.173.77:30500/node:24.13.0-alpine

WORKDIR /home/www/scanfree

COPY . .

EXPOSE 7994

ENV TZ=Asia/Shanghai \
    NODE_ENV=production

RUN chmod +x ./server/entrypoint.sh

ENTRYPOINT ["./server/entrypoint.sh"]
