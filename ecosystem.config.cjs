module.exports = {
  apps: [{
    name: 'uno-game',
    script: 'server/index.js',
    cwd: '/opt/uno-game',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production', PORT: 3001 }
  }]
};
