var Entities = require('html-entities').AllHtmlEntities
var entities = new Entities()
var request = require('micro-request')
var resolveUrl = require('url').resolve
var version = require('../../package.json').version
var sig = require('sig')
var parseUrl = require('url').parse
var assert = require('assert')
var robotsParser = require('robots-parser')
var USER_AGENT = 'zenbrain/' + version
var bytes = require('bytes')

module.exports = function container (get, set, clear) {
  var map = get('map')
  var config = get('config').crawler
  if (!config) throw new Error('no config found. please add it to ~/.zenbrain/config-zen_crawler.js')
  return function mapper (cb) {
    var run_state = get('run_state')
    if (!run_state.queue || !run_state.queue.length) {
      run_state.queue = [config.start_url]
    }
    ;(function getNext () {
      var current_url = run_state.queue.shift()
      if (!current_url) {
        get('logger').info('mapper', 'done mapping. closing!')
        get('app').close(function () {
          process.exit()
        })
        return
      }
      var cache_key = sig(current_url)
      try {
        var parsedUrl = parseUrl(current_url)
        assert(parsedUrl.protocol.match(/^http/))
      }
      catch (e) {
        return getNext()
      }
      var robots_txt_url = resolveUrl(parsedUrl.protocol + '//' + parsedUrl.host, '/robots.txt')
      var robots_txt_id = sig(robots_txt_url)
      get('thoughts').select({query: {key: robots_txt_id}, limit: 1}, function (err, result) {
        if (err) throw err
        if (result.length) {
          get('logger').info('mapper', 'cached'.grey, robots_txt_url.grey)
          return withRobotsTxt(result[0].value.headers, result[0].value.body)
        }
        get('logger').info('mapper', 'fetching', robots_txt_url)
        request(robots_txt_url, {headers: {'User-Agent': USER_AGENT}}, function (err, resp, body) {
          if (err) {
            get('logger').error('request err', robots_txt_url, err, {feed: 'errors'})
            return setImmediate(getNext)
          }
          resp.headers.statusCode = resp.statusCode
          map(robots_txt_id, {url: robots_txt_url, headers: resp.headers, body: body, is_base64: false})
          withRobotsTxt(resp.headers, body)
        })
      })
      function withRobotsTxt (headers, body) {
        if (headers.statusCode === 200 && typeof body === 'string') {
          return withRobots(robotsParser(robots_txt_url, body))
        }
        else if (headers.statusCode === 404) {
          // go for it anyway
          return withRobots(true)
        }
        else {
          return setImmediate(getNext)
        }
      }
      function withRobots (robots) {
        if (robots === true || (robots && robots.isDisallowed(current_url, USER_AGENT))) {
          get('logger').info('mapper', 'disallowed'.red, current_url.grey)
          return setImmediate(getNext)
        }
        get('thoughts').select({query: {key: sig(current_url)}, limit: 1}, function (err, result) {
          if (err) throw err
          if (result.length) {
            get('logger').info('mapper', 'cached'.grey, current_url.grey, result[0].value.headers.statusCode.grey)
            return setImmediate(getNext)
          }
          request(current_url, {headers: {'User-Agent': USER_AGENT}}, function (err, resp, body) {
            if (err) {
              get('logger').error('request err', current_url, err, {feed: 'errors'})
              return setImmediate(getNext)
            }
            get('logger').info('mapper', 'crawled', current_url.white, resp.statusCode.blue, bytes(Buffer(body).length), (resp.headers['content-type'] || '').grey, run_state.queue.length, 'left')
            var linkCount = 0
            var is_base64 = false
            if (resp.statusCode === 200 && typeof body === 'string') {
              var links = body.match(/<a [^>]*href=('|")[^'"]+('|")[^>]*>/gi)
              links = [resolveUrl(current_url, '/favicon.ico')].concat(links)
              if (links) {
                var new_links = 0
                links.forEach(function (link) {
                  if (!link) return
                  function getAttr (name) {
                    var matches = link.match(new RegExp('<a [^>]*' + name + '=(?:\'|")([^\'"]+)(?:\'|")[^>]*>', 'i'))
                    return matches && matches[1]
                  }
                  var rel = getAttr('rel')
                  if (rel && rel.match(/nofollow/)) return
                  var href = getAttr('href')
                  if (!href || href.match(/^#/)) return
                  href = resolveUrl(current_url, href).replace(/#.*/, '')
                  if (run_state.queue.length < config.queue_limit && run_state.queue.indexOf(href) === -1) {
                    run_state.queue.push(href)
                    new_links++
                  }
                })
                get('logger').info('mapper', 'found'.grey, new_links, 'new links.'.grey)
              }
            }
            else {
              get('logger').info('mapper', 'result', resp.statusCode, typeof body, body && body.length)
              if (resp.headers['location']) {
                run_state.queue.push(resolveUrl(current_url, resp.headers['location']))
              }
            }
            if (Buffer.isBuffer(body)) {
              is_base64 = true
              body = body.toString('base64')
            }
            resp.headers.statusCode = resp.statusCode
            map(sig(current_url), {url: current_url, headers: resp.headers, body: body, is_base64: is_base64})
            setImmediate(getNext)
          })
        })
      }
    })()
  }
}
