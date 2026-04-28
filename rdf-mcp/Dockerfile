FROM node:22-alpine
WORKDIR /app

# Copia package.json e installa dipendenze
COPY package.json .
RUN npm install --production

# Copia server, worker e normalizer
COPY server.js .
COPY worker.js .
COPY ttl-normalizer.js .


EXPOSE 3003
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app
USER appuser
CMD ["node", "server.js"]
