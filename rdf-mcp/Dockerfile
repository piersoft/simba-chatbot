FROM node:22-alpine
WORKDIR /app

# Copia package.json e installa dipendenze
COPY package.json .
RUN npm install --production

# Copia server, worker e normalizer
COPY server.js .
COPY worker.js .
COPY ttl-normalizer.js .

# worker.js è incluso nella repo con fix per normalizeTTL
# Il server scaricherà aggiornamenti notturni ma il fix viene riapplicato

EXPOSE 3003
CMD ["node", "server.js"]
