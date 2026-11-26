FROM node:22-alpine AS builder

# set the working dir
WORKDIR /app

# copy the package file which contains packages needed by the app to the current  dir (/app)
COPY package*.json ./

# install what is package.lock.json
RUN npm ci

COPY . .

RUN npm run build

# stage 2

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# copy package files so npm ci can install production deps here
COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 4000

USER node

CMD ["node", "dist/server.js"]

