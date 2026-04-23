FROM node:22-alpine

WORKDIR /app

# Dipendenze native per better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY . .

VOLUME ["/app/data"]

ENV PORT=3004
ENV NODE_ENV=production

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3004/health || exit 1

CMD ["node", "server.js"]
