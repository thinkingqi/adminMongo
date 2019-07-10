var express = require('express');
var path = require('path');
var logger = require('morgan');
var FileStreamRotator = require('file-stream-rotator')
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var handlebars = require('express-handlebars');
var nconf = require('nconf');
var session = require('express-session');
var async = require('async');
var moment = require('moment');
var fs = require('fs');

// Define routes
var indexRoute = require('./routes/index');
var apiRoute = require('./routes/api');
var usersRoute = require('./routes/users');
var configRoute = require('./routes/config');
var docRoute = require('./routes/document');
var dbRoute = require('./routes/database');
var collectionRoute = require('./routes/collection');

// set the base dir to __dirname when running as webapp and electron path if running as electron app
var dir_base = __dirname;
if(process.versions['electron']){
    dir_base = path.join(process.resourcesPath.toString(), 'app/');
}

var app = express();

// setup the translation
var i18n = new (require('i18n-2'))({
    locales: ['en', 'de', 'es', 'ru', 'zh-cn', 'it'],
    directory: path.join(dir_base, 'locales/')
});

// setup DB for server stats
var Datastore = require('nedb');
var db = new Datastore({filename: path.join(dir_base, 'data/dbStats.db'), autoload: true});

// view engine setup
app.set('views', path.join(dir_base, 'views/'));
app.engine('hbs', handlebars({extname: 'hbs', defaultLayout: path.join(dir_base, 'views/layouts/layout.hbs')}));
app.set('view engine', 'hbs');

// Check existence of backups dir, create if nothing
if(!fs.existsSync(path.join(dir_base, 'backups'))) fs.mkdirSync(path.join(dir_base, 'backups'));

// helpers for the handlebars templating platform
handlebars = handlebars.create({
    helpers: {
        __: function (value){
            return i18n.__(value);
        },
        toJSON: function (object){
            return JSON.stringify(object);
        },
        niceBool: function (object){
            if(object === undefined)return'No';
            if(object === true)return'Yes';
            return'No';
        },
        app_context: function (){
            if(nconf.stores.app.get('app:context') !== undefined){
                return'/' + nconf.stores.app.get('app:context');
            }return'';
        },
        ifOr: function (v1, v2, options){
            return(v1 || v2) ? options.fn(this) : options.inverse(this);
        },
        ifNotOr: function (v1, v2, options){
            return(v1 || v2) ? options.inverse(this) : options.fn(this);
        },
        ifCond: function(v1, v2, options) {
            if(v1 === v2) {
              return options.fn(this);
            }
            return options.inverse(this);
        },
        formatBytes: function (bytes){
            if(bytes === 0)return'0 Byte';
            var k = 1000;
            var decimals = 2;
            var dm = decimals + 1 || 3;
            var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
            var i = Math.floor(Math.log(bytes) / Math.log(k));
            return(bytes / Math.pow(k, i)).toPrecision(dm) + ' ' + sizes[i];
        },
        formatDuration: function(time){
            return moment.duration(time, 'seconds').humanize();
        }
    }
});

// setup nconf to read in the file
// create config dir and blank files if they dont exist
var dir_config = path.join(dir_base, 'config/');
var config_connections = path.join(dir_config, 'config.json');
var config_app = path.join(dir_config, 'app.json');

// Check existence of config dir and config files, create if nothing
if(!fs.existsSync(dir_config)) fs.mkdirSync(dir_config);

// The base of the /config/app.json file, will check against environment values
var configApp = {
    app: {}
};
if(process.env.HOST) configApp.app.host = process.env.HOST;
if(process.env.PORT) configApp.app.port = process.env.PORT;
if(process.env.PASSWORD) configApp.app.password = process.env.PASSWORD;
if(process.env.LOCALE) configApp.app.locale = process.env.LOCALE;
if(process.env.CONTEXT) configApp.app.context = process.env.CONTEXT;
if(process.env.MONITORING) configApp.app.monitoring = process.env.MONITORING;

if(!fs.existsSync(config_app)) fs.writeFileSync(config_app, JSON.stringify(configApp));

// Check the env for a connection to initiate
var configConnection = {
    connections: {}
};
if(process.env.CONN_NAME && process.env.DB_HOST) {
    if(!process.env.DB_PORT) process.env.DB_PORT = '27017'; // Use the default mongodb port when DB_PORT is not set
    var connectionString = 'mongodb://';
    if(process.env.DB_USERNAME && process.env.DB_PASSWORD && process.env.DB_NAME) {
        connectionString += process.env.DB_USERNAME + ':' + process.env.DB_PASSWORD + '@' + process.env.DB_HOST + ':' + process.env.DB_PORT + '/' + process.env.DB_NAME;
    }else if (process.env.DB_USERNAME && process.env.DB_PASSWORD) {
        connectionString += process.env.DB_USERNAME + ':' + process.env.DB_PASSWORD + '@' + process.env.DB_HOST + ':' + process.env.DB_PORT + '/'
    } else {    
        connectionString += process.env.DB_HOST + ':' + process.env.DB_PORT
    }
    configConnection.connections[process.env.CONN_NAME] = {
        connection_options: {},
        connection_string: connectionString
    };
}
if (!fs.existsSync(config_connections) || fs.readFileSync(config_connections, 'utf8') === '{}')
    fs.writeFileSync(config_connections, JSON.stringify(configConnection));

// if config files exist but are blank we write blank files for nconf
if(fs.existsSync(config_app, 'utf8')){
    if(fs.readFileSync(config_app, 'utf8') === ''){
        fs.writeFileSync(config_app, '{}', 'utf8');
    }
}
if(fs.existsSync(config_connections, 'utf8')){
    if(fs.readFileSync(config_connections, 'utf8') === ''){
        fs.writeFileSync(config_connections, '{}', 'utf8');
    }
}

// setup the two conf. 'app' holds application config, and connections
// holds the mongoDB connections
nconf.add('connections', {type: 'file', file: config_connections});
nconf.add('app', {type: 'file', file: config_app});

// set app defaults
var app_host = process.env.HOST || 'localhost';
var app_port = process.env.PORT || 1234;

// get the app configs and override if present
if(nconf.stores.app.get('app:host') !== undefined){
    app_host = nconf.stores.app.get('app:host');
}
if(nconf.stores.app.get('app:port') !== undefined){
    app_port = nconf.stores.app.get('app:port');
}
if(nconf.stores.app.get('app:locale') !== undefined){
    i18n.setLocale(nconf.stores.app.get('app:locale'));
}

app.locals.app_host = app_host;
app.locals.app_port = app_port;

// setup the app context
var app_context = '';
if(nconf.stores.app.get('app:context') !== undefined){
    app_context = '/' + nconf.stores.app.get('app:context');
}







// log cutting config
var logDirectory = path.join(__dirname, 'logs')

// ensure log directory exists
fs.existsSync(logDirectory) || fs.mkdirSync(logDirectory)

// create a rotating write stream
var accessLogStream = FileStreamRotator.getStream({
  date_format: 'YYYY-MM-DD',
  filename: path.join(logDirectory, 'access-%DATE%.log'),
  frequency: 'daily',
  verbose: false
})

// setup the logger == morgan
// app.use(logger('combined', {stream: accessLogStream}))

// self Date Format
// 對Date的擴展，將 Date 轉化爲指定格式的String
// 月(M)、日(d)、小時(h)、分(m)、秒(s)、季度(q) 可以用 1-2 個佔位符， 
// 年(y)可以用 1-4 個佔位符，毫秒(S)只能用 1 個佔位符(是 1-3 位的數字) 
// 例子： 
// (new Date()).Format("yyyy-MM-dd hh:mm:ss.S") ==> 2006-07-02 08:09:04.423 
// (new Date()).Format("yyyy-M-d h:m:s.S")      ==> 2006-7-2 8:9:4.18 
Date.prototype.Format = function (fmt) { //author: meizz 
    var o = {
        "M+": this.getMonth() + 1, //月份 
        "d+": this.getDate(), //日 
        "h+": this.getHours(), //小時 
        "m+": this.getMinutes(), //分 
        "s+": this.getSeconds(), //秒 
        "q+": Math.floor((this.getMonth() + 3) / 3), //季度 
        "S": this.getMilliseconds() //毫秒 
    };
    if (/(y+)/.test(fmt)) fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
    for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt)) fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
    return fmt;
}


// self token 
logger.token('from', function(req, res){
    return JSON.stringify(req.params) || '-';
});
logger.token('date', function(req, res){
    return new Date().Format("yyyy-MM-dd hh:mm:ss"); 
});

logger.token('username', function (req, res) { 
    var username = req.session.userName ? req.session.userName: "Guest";
    return username;
});

// app.use(logger(':date :username :from :remote-addr :remote-user :method :url HTTP/:http-version :status :res[content-length] - :response-time ms', {stream: accessLogStream}))
app.use(logger(':date :username :from :remote-addr :remote-user :method :url :status :res[content-length] - :response-time ms', {stream: accessLogStream}))
// app.use(logger(function (tokens, req, res) {
//     return [
//       tokens.method(req, res),
//       tokens.url(req, res),
//       tokens.status(req, res),
//       tokens.res(req, res, 'content-length'), '-',
//       tokens['response-time'](req, res), 'ms'
//     ].join(' ')
//   }, {stream: accessLogStream}))







app.use(logger('dev'));
app.use(bodyParser.json({limit: '16mb'}));
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());

// setup session
app.use(session({
    secret: '858SGTUyX8w1L6JNm1m93Cvm8uX1QX2D',
    resave: true,
    saveUninitialized: true
    // store: new Datastore({filename: path.join(dir_base, 'data/sessStats.db'), autoload: true})
}));

// front-end modules loaded from NPM
app.use(app_context + '/static', express.static(path.join(dir_base, 'public/')));
app.use(app_context + '/font-awesome', express.static(path.join(dir_base, 'node_modules/font-awesome/')));
app.use(app_context + '/jquery', express.static(path.join(dir_base, 'node_modules/jquery/dist/')));
app.use(app_context + '/bootstrap', express.static(path.join(dir_base, 'node_modules/bootstrap/dist/')));
app.use(app_context + '/css', express.static(path.join(dir_base, 'public/css')));
app.use(app_context + '/fonts', express.static(path.join(dir_base, 'public/fonts')));
app.use(app_context + '/js', express.static(path.join(dir_base, 'public/js')));
app.use(app_context + '/favicon.ico', express.static(path.join(dir_base, 'public/favicon.ico')));

// Make stuff accessible to our router
app.use(function (req, res, next){
    req.nconf = nconf.stores;
    req.handlebars = handlebars;
    req.i18n = i18n;
    req.app_context = app_context;
    req.db = db;
    next();
});

// add context to route if required
if(app_context !== ''){
    app.use(app_context, apiRoute);
    app.use(app_context, usersRoute);
    app.use(app_context, configRoute);
    app.use(app_context, docRoute);
    app.use(app_context, dbRoute);
    app.use(app_context, collectionRoute);
    app.use(app_context, indexRoute);
}else{
    app.use('/', apiRoute);
    app.use('/', usersRoute);
    app.use('/', configRoute);
    app.use('/', docRoute);
    app.use('/', dbRoute);
    app.use('/', collectionRoute);
    app.use('/', indexRoute);
}

// catch 404 and forward to error handler
app.use(function (req, res, next){
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// === Error handlers ===

// development error handler
// will print stacktrace
if(app.get('env') === 'development'){
    app.use(function (err, req, res, next){
        console.log(err.stack);
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err,
            helpers: handlebars.helpers
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next){
    console.log(err.stack);
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {},
        helpers: handlebars.helpers
    });
});

app.on('uncaughtException', function(err){
    console.error(err.stack);
    process.exit();
});

// add the connections to the connection pool
var connection_list = nconf.stores.connections.get('connections');
var connPool = require('./connections');
var monitoring = require('./monitoring');
app.locals.dbConnections = null;

async.forEachOf(connection_list, function (value, key, callback){
    var MongoURI = require('mongo-uri');

    /*
    value:{"connection_string":"mongodb://xxxx:xxxx@1.1.1.1:27101","connection_options":{"poolSize":10,"autoReconnect":false,"ssl":false}}
    key:"PMongoDB"
    */
    try{
        MongoURI.parse(value.connection_string);
        connPool.addConnection({connName: key, connString: value.connection_string, connOptions: value.connection_options}, app, function (err, data){
            if(err)delete connection_list[key];
            callback();
        });
    }catch(err){
        callback();
    }
},
    function (err){
        if(err) console.error(err.message);
        // lift the app
        app.listen(app_port, app_host, function (){
            console.log('adminMongo listening on host: http://' + app_host + ':' + app_port + app_context);

            // used for electron to know when express app has started
            app.emit('startedAdminMongo');

            if(nconf.stores.app.get('app:monitoring') !== false){
                // start the initial monitoring
                monitoring.serverMonitoring(db, app.locals.dbConnections);

                // Keep firing monitoring every 30 seconds
                setInterval(function (){
                    monitoring.serverMonitoring(db, app.locals.dbConnections);
                }, 30000);
            }
        }).on('error', function (err){
            if(err.code === 'EADDRINUSE'){
                console.error('Error starting adminMongo: Port ' + app_port + ' already in use, choose another');
            }else{
                console.error('Error starting adminMongo: ' + err);
                app.emit('errorAdminMongo');
            }
        });
    });

module.exports = app;
