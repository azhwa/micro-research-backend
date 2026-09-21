module.exports = {
  apps: [
    {
      name: "micro-research-backend",
      cwd: __dirname,
      script: "./dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      restart_delay: 5_000,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: "2G",
      kill_timeout: 10_000,
      listen_timeout: 10_000,
      time: true,
      merge_logs: true,
      out_file: "./logs/backend-out.log",
      error_file: "./logs/backend-error.log",
      env_production: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: 3315,
        DISPLAY: ":99",
        CRAWLER_BROWSER: "cloak",
        PLAYWRIGHT_HEADLESS: "true",
        // Reuse the profile that previously passed Adobe's geo/DataDome
        // bootstrap. CDP is disabled; Cloak owns this profile now.
        CLOAKBROWSER_PROFILE_DIR: "/home/ubuntu/snap/chromium/common/adobe-profile",
        CLOAKBROWSER_HUMANIZE: "false"
      }
    }
  ]
};
