FROM eclipse-temurin:8-jdk-jammy AS jdk
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN mkdir -p /run/exam-judge && chown node:node /run/exam-judge && chmod 1777 /run/exam-judge
COPY selfhost/judge.mjs selfhost/mysql-judge.mjs selfhost/sql-policy.mjs selfhost/
COPY selfhost/judge/run.py selfhost/judge/
COPY worker/index.mjs worker/
COPY selfhost/runtime.mjs selfhost/

FROM base AS java-worker
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=jdk /opt/java/openjdk /opt/exam-java8
COPY selfhost/java-worker.mjs selfhost/
COPY selfhost/judge/java8.py selfhost/judge/
ENV EXAM_JAVA8_HOME=/opt/exam-java8 EXAM_DEDICATED_JAVA_WORKER=1 EXAM_JUDGE_PYTHON=/usr/bin/python3 PYTHONDONTWRITEBYTECODE=1
USER node
CMD ["node","selfhost/java-worker.mjs"]

FROM base AS wasi-worker
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && python3 -m venv /opt/exam-judge && /opt/exam-judge/bin/pip install --no-cache-dir wasmtime==50.0.1 && rm -rf /var/lib/apt/lists/*
COPY worker/index.mjs worker/
COPY selfhost/wasi-worker.mjs selfhost/
COPY selfhost/judge/*.wasm selfhost/judge/
COPY selfhost/judge/*LICENSE selfhost/judge/
ENV EXAM_JUDGE_PYTHON=/opt/exam-judge/bin/python PYTHONDONTWRITEBYTECODE=1 XDG_CACHE_HOME=/tmp/.cache
USER node
CMD ["node","selfhost/wasi-worker.mjs"]

FROM base AS exam
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv fonts-wqy-zenhei fonts-dejavu-core && python3 -m venv /opt/exam-judge && /opt/exam-judge/bin/pip install --no-cache-dir wasmtime==50.0.1 reportlab==5.1.0 pygments==2.21.0 && rm -rf /var/lib/apt/lists/*
COPY worker/ worker/
COPY selfhost/*.mjs selfhost/*.js selfhost/answer_pdf.py selfhost/
COPY selfhost/judge/*.wasm selfhost/judge/
COPY selfhost/judge/*LICENSE selfhost/judge/
COPY scripts/check-judge.mjs scripts/
RUN mkdir -p /data && chown node:node /data
ENV EXAM_PDF_PYTHON=/opt/exam-judge/bin/python HOST=0.0.0.0 PORT=8787 EXAM_DATA=/data EXAM_JUDGE_PYTHON=/opt/exam-judge/bin/python EXAM_JAVA_SOCKET=/run/exam-judge/java.sock EXAM_WASI_SOCKET=/run/exam-judge/wasi.sock EXAM_MYSQL_SOCKET=/run/exam-judge/mysql.sock
USER node
EXPOSE 8787
CMD ["node","selfhost/server.mjs"]

FROM mysql:8.4 AS mysql-worker
RUN mkdir -p /run/exam-judge && chmod 1777 /run/exam-judge
COPY --from=base /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY selfhost/mysql-worker.mjs selfhost/mysql-judge.mjs selfhost/mysql-watchdog.mjs selfhost/sql-policy.mjs selfhost/
COPY selfhost/runtime.mjs selfhost/
ENV EXAM_MYSQL_CLIENT=/usr/bin/mysql EXAM_MYSQL_SERVER=/usr/sbin/mysqld
USER mysql
CMD ["node","selfhost/mysql-worker.mjs"]
