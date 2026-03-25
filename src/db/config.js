const dbConfig = {
  master: {
    host: '192.168.10.102',
    port: 3306,
    user: 'root',
    password: '1qazXSW@',
    database: 'demo_db'
  },
  slave: {
    host: '192.168.10.103',
    port: 3306,
    user: 'root',
    password: '1qazXSW@',
    database: 'demo_db'
  }
};

module.exports = dbConfig;