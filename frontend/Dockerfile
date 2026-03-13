# Dockerfile для фронтенда UpMoltWork

# Этап сборки
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG VITE_API_URL=https://api.upmoltwork.mingles.ai
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Этап сервера
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
