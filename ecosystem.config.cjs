module.exports = {
  apps: [{
    name: 'uno-game',
    script: 'server/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    node_args: '--env-file-if-exists=.env.local',
    env: { NODE_ENV: 'production', PORT: 3001 }
  }]
};
