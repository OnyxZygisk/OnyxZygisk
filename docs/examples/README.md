# FN 节点示例

`hello/` 是一个脚本型 FN 节点：trigger 为 `boot`，在 late-start 时执行
`service.sh`，向 `/data/local/tmp/fn-hello.txt` 写一行标记。

## 安装

```sh
# 打包（在 docs/examples 下）：
cd hello
zip -r ../hello-fn.zip fn.prop service.sh

# 方式一：WebUI → FN 模块 → 上传安装
# 方式二：直接放文件（调试用）：
mkdir -p /data/adb/onyxzygisk/fn/hello
cp fn.prop service.sh /data/adb/onyxzygisk/fn/hello/
chmod 755 /data/adb/onyxzygisk/fn/hello/service.sh
```

安装后无需重启：`boot`/`post_fs_data` 触发器在守护进程运行期间的后续
启动事件中生效；`app`/`system_server` 触发器在下一个进程 fork 时生效。

## 原生入口节点

FN 原生入口库与经典 Zygisk 模块使用同一套 API（Zygisk API v4，入口符号
`zygisk_module_entry`），协议头在 `loader/src/include/api.hpp`。典型结构：

```c
// fn.c —— 与 zygisk_module_entry 对应
#include <stddef.h>
#include <string.h>

typedef struct { long api_version; void *impl; void (*preAppSpecialize)(void *, void *);
                 void (*postAppSpecialize)(void *, const void *);
                 void (*preServerSpecialize)(void *, void *);
                 void (*postServerSpecialize)(void *, const void *); } module_abi_v1;

typedef struct { void *impl; int (*registerModule)(void *, long *); } api_abi_base;

typedef struct {
    api_abi_base base;
    /* v1 */ void (*hookJniNativeMethods)(void *, const char *, void *, int);
    void (*pltHookRegister)(const char *, const char *, void *, void **);
    void (*pltHookExclude)(const char *, const char *);
    int (*pltHookCommit)(void);
    int (*connectCompanion)(void *);
    void (*setOption)(void *, int);
    /* v2 */ int (*getModuleDir)(void *);
    unsigned int (*getFlags)(void *);
} api_abi_v2;

static void on_app(void *impl, void *args) {}
static void on_app_post(void *impl, const void *args) {}
static void on_server(void *impl, void *args) {}
static void on_server_post(void *impl, const void *args) {}

static int register_module(void *api_void, long *module) {
    api_abi_base *api = api_void;
    module_abi_v1 *mod = (module_abi_v1 *)module;
    api->impl = module;  // 存放模块 ABI 供后续回调
    mod->preAppSpecialize = on_app;
    mod->postAppSpecialize = on_app_post;
    mod->preServerSpecialize = on_server;
    mod->postServerSpecialize = on_server_post;
    return 1;
}

void zygisk_module_entry(void *api, void *env) {
    // api->base.registerModule(api, &module_abi)
    ((api_abi_base *)api)->registerModule(api, &(module_abi_v1){
        .api_version = 4, .impl = 0,
        .preAppSpecialize = on_app, .postAppSpecialize = on_app_post,
        .preServerSpecialize = on_server, .postServerSpecialize = on_server_post,
    });
}
```

`fn.prop` 中声明 `entry=lib/arm64-v8a/fn.so`（lib 目录按 ABI 放库文件），
`trigger=app` 表示注入到应用进程，`scope`/`apps` 控制目标应用集合。

## 作为 Magisk 模块安装

FN 节点也可以直接制作成标准 Magisk 模块。目录必须同时包含
`module.prop` 和 `fn.prop`，然后打包并在 Magisk Manager 中刷入：

```sh
cd magisk-hello
zip -r ../hello-fn-magisk.zip module.prop fn.prop service.sh
```

OnyxZygisk 通过 `fn.prop` 识别该模块，不会把普通 Magisk 模块当成 FN
节点。标准 Magisk 模块的 `post-fs-data.sh` 和 `service.sh` 由 Magisk
负责执行，OnyxZygisk 不会重复调度它们。
