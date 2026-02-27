#!/usr/bin/env node

import { proxyConfig } from "./proxy/config.js";
import { runProxyCliFromProcess } from "./proxy/repl.js";
import { runProxyTelegramFromProcess } from "./proxy/telegram.js";

if (proxyConfig.telegramBotToken) {
  void runProxyTelegramFromProcess();
} else {
  void runProxyCliFromProcess();
}
