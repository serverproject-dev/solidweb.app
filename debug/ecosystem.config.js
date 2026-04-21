`#less /etc/jss/ecosystem.config.js` :
```
module.exports = {
  apps: [
    {
      name: 'jss',
      // Full absolute path — PM2 at boot does not source .bashrc and cannot
      // resolve nvm shims.
      script: '/home/jss/.nvm/versions/node/v24.11.0/bin/jss',
      args: 'start --config /etc/jss/config.json',
      cwd: '/var/lib/jss',

      exec_mode: 'fork',   // correct for JSS — cluster mode is for stateless HTTP apps
      instances: 1,

      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 4000,
      max_memory_restart: '512M',

      out_file:   '/home/jss/.pm2/logs/jss-out.log',
      error_file: '/home/jss/.pm2/logs/jss-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env_production: {
        NODE_ENV: 'production',
        PATH: '/home/jss/.nvm/versions/node/v24.11.0/bin:' + process.env.PATH,
      },
    },
  ],
};
```
