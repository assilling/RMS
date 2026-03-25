const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { exec } = require('child_process');
const dbConfig = require('./db/config');

// SSH設定
const SSH_CONFIG = {
  masterHost: '192.168.10.102',
  slaveHost: '192.168.10.103',
  user: 'root',
  password: '1qazXSW@',
  timeout: 10000
};

console.log('[Server] SSH設定を読み込みました');
console.log(`[Server] Master SSH: ${SSH_CONFIG.user}@${SSH_CONFIG.masterHost}`);
console.log(`[Server] Slave SSH: ${SSH_CONFIG.user}@${SSH_CONFIG.slaveHost}`);

// SSH実行関数 - expectで直接コマンド実行
const fs = require('fs');
const path = require('path');

function sshExec(host, command) {
  return new Promise((resolve, reject) => {
    // SSHで直接コマンドを実行、expectスクリプトのネスト問題を回避
    const cmdEscaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    const passEscaped = SSH_CONFIG.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const scriptContent = `#!/usr/bin/expect -f
set timeout 60
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_CONFIG.user}@${host}
expect {
  "password:" {}
  timeout { exit 1 }
}
send "${passEscaped}\\r"
expect {
  "#" {}
  "$" {}
}
send "${cmdEscaped}\\r"
expect {
  "#" {}
  "$" {}
}
send "exit\\r"
expect eof
`;

    const scriptPath = path.join(__dirname, `ssh_${Date.now()}.expect`);
    fs.writeFileSync(scriptPath, scriptContent);

    console.log(`[SSH] ${host} でコマンドを実行します: ${command}`);
    exec(`chmod +x "${scriptPath}" && expect "${scriptPath}"`, { timeout: 60000 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(scriptPath); } catch(e) {}
      if (error) {
        console.log(`[SSH] ${host} 実行失敗: ${error.message}, stderr: ${stderr}`);
        reject(new Error(`${error.message}, stderr: ${stderr}`));
      } else {
        console.log(`[SSH] ${host} 実行成功, 出力: ${stdout.substring(0, 200)}`);
        resolve(stdout);
      }
    });
  });
}

// SSHでMySQLコマンド実行 - -eパラメータでSQL直接実行
function sshMysql(host, sql) {
  console.log(`[MySQL] ${host} で実行: ${sql}`);
  // 全体をシングルクォートで包む
  const escapedSql = sql.replace(/'/g, "'\\''");
  return sshExec(host, `mysql -u root -p'${SSH_CONFIG.password}' -e '${escapedSql}'`);
}

const app = express();
app.use(cors());
app.use(express.json());

// 静的ファイルサービス - appディレクトリから提供
app.use(express.static('app'));

// 接続プール作成
const masterPool = mysql.createPool({
  ...dbConfig.master,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 3000
});

const slavePool = mysql.createPool({
  ...dbConfig.slave,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 3000
});

// 現在の主庫設定 - デフォルトはmaster
let currentMaster = 'master';

// 現在の接続先DBを取得
function getCurrentPool() {
  return currentMaster === 'master' ? masterPool : slavePool;
}

// タイムアウト付きクエリ
async function queryWithTimeout(pool, sql, timeout = 3000) {
  try {
    const conn = await Promise.race([
      pool.getConnection(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout))
    ]);
    try {
      const [rows] = await conn.query(sql);
      conn.release();
      return rows;
    } catch (e) {
      conn.release();
      throw e;
    }
  } catch (e) {
    throw e;
  }
}

// API: データベース状態取得
app.get('/api/db/status', async (req, res) => {
  console.log('[DB Status] ステータス確認中...');
  try {
    // 192.168.10.102の状態を確認
    const db1P = queryWithTimeout(masterPool, 'SHOW SLAVE STATUS', 3000)
      .then((rows) => {
        console.log('[DB Status] 102 取得成功, rows:', rows);
        return queryWithTimeout(masterPool, 'SHOW MASTER STATUS', 3000)
          .then((binlogRows) => {
            const latestLog = binlogRows[0] ? binlogRows[binlogRows.length - 1] : null;
            // 半同期レプリケーション状態を取得
            return queryWithTimeout(masterPool, "SHOW STATUS LIKE 'Rpl_semi_sync_master_status'", 3000)
              .then((masterRows) => {
                const isMaster = masterRows && masterRows.length > 0 && masterRows[0]?.Value === 'ON';
                return queryWithTimeout(masterPool, "SHOW STATUS LIKE 'Rpl_semi_sync_slave_status'", 3000)
                  .then((slaveRows) => {
                    const isSlave = slaveRows && slaveRows.length > 0 && slaveRows[0]?.Value === 'ON';
                    return {
                      host: '192.168.10.102',
                      status: 'UP',
                      isMaster: isMaster,
                      isSlave: isSlave,
                      binlog: latestLog?.File || null,
                      position: latestLog?.Position || null,
                      secondsBehindMaster: rows && rows.length > 0 ? (rows[0]?.Seconds_Behind_Master || 0) : 0,
                      slaveIO: rows && rows.length > 0 ? (rows[0]?.Slave_IO_Running || 'No') : '-',
                      slaveSQL: rows && rows.length > 0 ? (rows[0]?.Slave_SQL_Running || 'No') : '-',
                      semiSync: isMaster ? 'ON' : 'OFF'
                    };
                  });
              });
          });
      })
      .catch((e) => {
        console.log('[DB Status] 102 失敗:', e.message);
        return {
          host: '192.168.10.102',
          status: 'DOWN',
          isMaster: false,
          isSlave: false,
          error: e.message
        };
      });

    // 192.168.10.103の状態を確認
    const db2P = queryWithTimeout(slavePool, 'SHOW SLAVE STATUS', 3000)
      .then((rows) => {
        console.log('[DB Status] 103 取得成功, rows:', rows);
        return queryWithTimeout(slavePool, 'SHOW MASTER STATUS', 3000)
          .then((binlogRows) => {
            const latestLog = binlogRows[0] ? binlogRows[binlogRows.length - 1] : null;
            return queryWithTimeout(slavePool, "SHOW STATUS LIKE 'Rpl_semi_sync_master_status'", 3000)
              .then((masterRows) => {
                const isMaster = masterRows && masterRows.length > 0 && masterRows[0]?.Value === 'ON';
                return queryWithTimeout(slavePool, "SHOW STATUS LIKE 'Rpl_semi_sync_slave_status'", 3000)
                  .then((slaveRows) => {
                    const isSlave = slaveRows && slaveRows.length > 0 && slaveRows[0]?.Value === 'ON';
                    return {
                      host: '192.168.10.103',
                      status: 'UP',
                      isMaster: isMaster,
                      isSlave: isSlave,
                      binlog: latestLog?.File || null,
                      position: latestLog?.Position || null,
                      secondsBehindMaster: rows && rows.length > 0 ? (rows[0]?.Seconds_Behind_Master || 0) : 0,
                      slaveIO: rows && rows.length > 0 ? (rows[0]?.Slave_IO_Running || 'No') : '-',
                      slaveSQL: rows && rows.length > 0 ? (rows[0]?.Slave_SQL_Running || 'No') : '-',
                      semiSync: isMaster ? 'ON' : 'OFF'
                    };
                  });
              });
          });
      })
      .catch((e) => {
        console.log('[DB Status] 103 失敗:', e.message);
        return {
          host: '192.168.10.103',
          status: 'DOWN',
          isMaster: false,
          isSlave: false,
          error: e.message
        };
      });

    const [db1, db2] = await Promise.all([db1P, db2P]);

    // Rpl_semi_sync_master_status=ON がマスター、Rpl_semi_sync_slave_status=ON がスレーブ
    let master, slave;
    if (db1.isMaster && !db2.isMaster) {
      // db1がマスター
      master = db1;
      slave = db2;
    } else if (db2.isMaster && !db1.isMaster) {
      // db2がマスター
      master = db2;
      slave = db1;
    } else if (db1.isMaster && db2.isMaster) {
      // 両方マスター（dual-master）
      // currentMaster設定で決定
      if (currentMaster === 'master') {
        master = db1;
        slave = db2;
      } else {
        master = db2;
        slave = db1;
      }
    } else {
      // どちらもマスターでない場合（古い設定など）
      master = db1;
      slave = db2;
    }

    res.json({
      currentMaster: currentMaster,
      master: master,
      slave: slave
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 手動で主庫切替
app.post('/api/db/switch', (req, res) => {
  currentMaster = currentMaster === 'master' ? 'slave' : 'master';
  res.json({
    success: true,
    currentMaster: currentMaster,
    message: `${currentMaster === 'master' ? '192.168.10.102' : '192.168.10.103'} に切替ました`
  });
});

// API: 元主庫に戻す
app.post('/api/db/switch-back', (req, res) => {
  currentMaster = 'master';
  res.json({
    success: true,
    message: '元主庫 192.168.10.102 に戻しました'
  });
});

// API: 主庫MySQL停止
app.post('/api/db/stop-master', async (req, res) => {
  try {
    // 現在の主庫IPを特定
    const masterIP = currentMaster === 'master' ? SSH_CONFIG.masterHost : SSH_CONFIG.slaveHost;
    console.log(`[DB Stop] 主庫停止準備: ${masterIP}`);

    // テスト用コマンド - uptimeで接続確認
    // 実際の停止コマンド: systemctl stop mysqld
    const testCommand = 'uptime';
    console.log(`[DB Stop] SSH接続テスト (実行: ${testCommand})`);

    try {
      await sshExec(masterIP, testCommand);
      res.json({
        success: true,
        message: `SSH接続テスト成功。${masterIP} のMySQLを停止できます。`,
        testOnly: true,
        masterIP: masterIP
      });
    } catch (sshError) {
      res.status(500).json({
        success: false,
        error: `SSH接続失敗: ${sshError.message}`,
        masterIP: masterIP
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 実際に主庫停止実行（危険操作）
app.post('/api/db/stop-master-confirm', async (req, res) => {
  try {
    const masterIP = currentMaster === 'master' ? SSH_CONFIG.masterHost : SSH_CONFIG.slaveHost;
    console.log(`[DB Stop] ⚠️ 主庫MySQL停止実行: ${masterIP}`);

    // 実際の停止コマンド - sudo使用
    const stopCommand = 'sudo systemctl stop mysqld';
    console.log(`[DB Stop] 実行コマンド: ${stopCommand}`);

    await sshExec(masterIP, stopCommand);

    res.json({
      success: true,
      message: `${masterIP} に停止コマンドを送信しました`,
      masterIP: masterIP
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 強制 Failover - 完全な半同期切替流程
app.post('/api/db/force-failover', async (req, res) => {
  console.log('[Failover] 強制Failover流程を開始...');

  const results = {
    steps: [],
    success: false
  };

  try {
    // 現在の主庫と新主庫を特定
    // 現在の設定: currentMaster = 'slave' は 103 が主庫, 102 が从庫(既にdown)
    const oldMasterIP = SSH_CONFIG.masterHost;  // 192.168.10.102 (元の主庫,既にdown)
    const newMasterIP = SSH_CONFIG.slaveHost;    // 192.168.10.103 (現在の主庫)

    console.log(`[Failover] 元主庫: ${oldMasterIP}, 新主庫: ${newMasterIP}`);

    // ===== Step 1: 新主庫 (103) で半同期主庫モード有効 =====
    console.log('[Failover] Step 1: 新主庫で半同期主庫モードを有効...');
    results.steps.push({ name: '半同期主庫有効化', host: newMasterIP, status: 'pending' });
    try {
      await sshMysql(newMasterIP, "SET GLOBAL rpl_semi_sync_master_enabled = 1;");
      results.steps[0].status = 'success';
      console.log('[Failover] Step 1 完了');
    } catch (e) {
      results.steps[0].status = 'error';
      results.steps[0].error = e.message;
      throw new Error(`Step 1 失敗: ${e.message}`);
    }

    // ===== Step 2: 元主庫 (102) を起動 =====
    console.log('[Failover] Step 2: 元主庫を起動...');
    results.steps.push({ name: '元主庫MySQL起動', host: oldMasterIP, status: 'pending' });
    try {
      // sudo systemctl でMySQL起動
      await sshExec(oldMasterIP, 'sudo systemctl start mysqld');
      results.steps[1].status = 'success';
      console.log('[Failover] Step 2 完了');
      // MySQL起動待ち
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      results.steps[1].status = 'error';
      results.steps[1].error = e.message;
      throw new Error(`Step 2 失敗: ${e.message}`);
    }

    // ===== Step 3: 元主庫 (102) を从庫として設定、新主庫 (103) に接続 =====
    console.log('[Failover] Step 3: 元主庫を从庫として設定...');
    results.steps.push({ name: '从庫接続設定', host: oldMasterIP, status: 'pending' });
    try {
      // slave停止・リセット
      await sshMysql(oldMasterIP, "STOP SLAVE; RESET SLAVE ALL;");
      // 新主庫を設定
      const changeMasterSQL = `CHANGE MASTER TO
MASTER_HOST='${newMasterIP}',
MASTER_USER='repl_user',
MASTER_PASSWORD='1qazXSW@',
MASTER_PORT=3306,
MASTER_AUTO_POSITION=1;`;
      await sshMysql(oldMasterIP, changeMasterSQL);
      await sshMysql(oldMasterIP, "START SLAVE;");
      results.steps[2].status = 'success';
      console.log('[Failover] Step 3 完了');
    } catch (e) {
      results.steps[2].status = 'error';
      results.steps[2].error = e.message;
      throw new Error(`Step 3 失敗: ${e.message}`);
    }

    // ===== Step 4: 元主庫 (102) で半同期从庫を有効 =====
    console.log('[Failover] Step 4: 半同期从庫を有効...');
    results.steps.push({ name: '半同期从庫有効化', host: oldMasterIP, status: 'pending' });
    try {
      await sshMysql(oldMasterIP, "SET GLOBAL rpl_semi_sync_slave_enabled = 1;");
      await sshMysql(oldMasterIP, "STOP SLAVE IO_THREAD;");
      await sshMysql(oldMasterIP, "START SLAVE IO_THREAD;");
      results.steps[3].status = 'success';
      console.log('[Failover] Step 4 完了');
    } catch (e) {
      results.steps[3].status = 'error';
      results.steps[3].error = e.message;
      throw new Error(`Step 4 失敗: ${e.message}`);
    }

    // ===== Step 5: 新主庫 (103) 状態を確認 =====
    console.log('[Failover] Step 5: 新主庫状態を確認...');
    results.steps.push({ name: '新主庫状態確認', host: newMasterIP, status: 'pending' });
    try {
      const masterStatus = await sshMysql(newMasterIP, "SHOW STATUS LIKE 'Rpl_semi_sync_master_status';");
      results.steps[4].status = 'success';
      results.steps[4].detail = masterStatus;
      console.log('[Failover] Step 5 完了:', masterStatus);
    } catch (e) {
      results.steps[4].status = 'error';
      results.steps[4].error = e.message;
    }

    // ===== Step 6: 新从庫 (102) 状態を確認 =====
    console.log('[Failover] Step 6: 新从庫状態を確認...');
    results.steps.push({ name: '新从庫状態確認', host: oldMasterIP, status: 'pending' });
    try {
      const slaveStatus = await sshMysql(oldMasterIP, "SHOW STATUS LIKE 'Rpl_semi_sync_slave_status';");
      const showSlave = await sshMysql(oldMasterIP, "SHOW SLAVE STATUS;");

      // IOとSQLが共にYesか確認
      const ioRunning = showSlave.includes('Slave_IO_Running: Yes');
      const sqlRunning = showSlave.includes('Slave_SQL_Running: Yes');

      results.steps[5].status = 'success';
      results.steps[5].detail = {
        semiSync: slaveStatus,
        ioRunning: ioRunning,
        sqlRunning: sqlRunning
      };
      console.log('[Failover] Step 6 完了: IO=' + ioRunning + ', SQL=' + sqlRunning);
    } catch (e) {
      results.steps[5].status = 'error';
      results.steps[5].error = e.message;
    }

    results.success = true;
    res.json(results);

  } catch (error) {
    results.error = error.message;
    res.status(500).json(results);
  }
});

// API: 全ゾーン取得
app.get('/api/zones', async (req, res) => {
  try {
    const pool = getCurrentPool();
    const [rows] = await pool.query('SELECT * FROM m_zones ORDER BY id');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: ゾーン1件取得
app.get('/api/zones/:id', async (req, res) => {
  try {
    const pool = getCurrentPool();
    const [rows] = await pool.query('SELECT * FROM m_zones WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: ゾーン作成
app.post('/api/zones', async (req, res) => {
  try {
    const pool = getCurrentPool();
    const { zone_code, zone_name, priority, description, status, enabled } = req.body;
    const [result] = await pool.query(
      'INSERT INTO m_zones (zone_code, zone_name, priority, description, status, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [zone_code, zone_name, priority || 0, description || '', status || 'ACTIVE', enabled ? 1 : 0]
    );
    res.json({ id: result.insertId, message: 'Zone created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: ゾーン更新
app.put('/api/zones/:id', async (req, res) => {
  try {
    const pool = getCurrentPool();
    const { zone_code, zone_name, priority, description, status, enabled } = req.body;
    await pool.query(
      'UPDATE m_zones SET zone_code=?, zone_name=?, priority=?, description=?, status=?, enabled=? WHERE id=?',
      [zone_code, zone_name, priority || 0, description || '', status || 'ACTIVE', enabled ? 1 : 0, req.params.id]
    );
    res.json({ success: true, message: 'Zone updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: ゾーン削除
app.delete('/api/zones/:id', async (req, res) => {
  try {
    const pool = getCurrentPool();
    await pool.query('DELETE FROM m_zones WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Zone deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`RCS Server running on http://localhost:${PORT}`);
  console.log(`フロントページ: http://localhost:${PORT}/zone_list.html`);
  console.log(`データベース監視: http://localhost:${PORT}/db_monitor.html`);
});