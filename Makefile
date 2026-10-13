NAME = scanfree
VERSION = $(shell cat package.json | grep '"version"' | head -1 | sed 's/.*: "\([^"]*\)".*/\1/')
REGISTRY_PREFIX = 172.24.173.77:30500/

.PHONY: build publish version run test

build:
	docker build -t ${NAME}:${VERSION} .

publish:
	docker tag ${NAME}:${VERSION} ${REGISTRY_PREFIX}${NAME}:${VERSION}
	docker push ${REGISTRY_PREFIX}${NAME}:${VERSION}

version:
	@echo ${VERSION}

# 本地起服务端（不配 Key 也能起，在线识别会自动显示为"未开通"）
run:
	node server/server.js

test:
	node --test tests/*.test.mjs
