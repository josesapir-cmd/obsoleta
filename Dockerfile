FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js preview.js ./
COPY public ./public
RUN mkdir /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
