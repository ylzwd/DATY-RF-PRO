"""One explicitly authorized production reset; ordinary databases unaffected."""
import unified_database as db
RESET_EPOCH = '3e9fae7920f14e248e6362a61b4a6cd4'
def reject_legacy_cache(connection):
    if db.status(connection)['epoch']==RESET_EPOCH:
        raise db.DatabaseError('正式数据库已从零初始化，旧浏览器缓存自动迁移已关闭，请刷新页面',code='LEGACY_CACHE_RETIRED',status=409)
