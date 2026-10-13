FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages openpyxl==3.1.5 numpy==2.1.3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
