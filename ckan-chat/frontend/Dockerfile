FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Riceve VITE_BACKEND_URL dal docker-compose come build arg
ARG VITE_BACKEND_URL=http://localhost:3001
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
RUN echo 'server { \
  listen 80; \
  root /usr/share/nginx/html; \
  index index.html; \
  location /api/ { \
    proxy_pass http://backend:3001; \
    proxy_read_timeout 300s; \
    proxy_connect_timeout 30s; \
    proxy_send_timeout 300s; \
  } \
  location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$ { \
    try_files $uri =404; \
    add_header Cache-Control "public, max-age=31536000, immutable"; \
  } \
  location / { \
    try_files $uri $uri/ /index.html; \
  } \
}' > /etc/nginx/conf.d/default.conf
EXPOSE 80
