FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/pulse-shift-lms.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
