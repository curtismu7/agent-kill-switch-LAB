# Server only (KS0). The final image carries the server and nothing else: no host tools, no outbound calls.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production KILL_SWITCH_PORT=6550
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev -w server --ignore-scripts && npm cache clean --force
COPY server/src server/src
USER node
EXPOSE 6550
# Inside the container the server must listen on all interfaces, so KILL_SWITCH_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely.
ENV KILL_SWITCH_BIND=0.0.0.0
CMD ["node", "server/src/index.js"]
