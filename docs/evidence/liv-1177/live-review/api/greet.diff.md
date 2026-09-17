# 同一输入前后对比

输入来自事项示例与已有六项测试。真实执行父提交和实现提交源码：父提交 1/6 符合新验收，实现 6/6 符合。

- 输入 `"Ada"`：`"Hello, Ada!"` → `"Hello, Ada!"`。
- 输入 `""`：`"Hello, !"` → `"Hello, world!"`。
- 输入 `"   "`：`"Hello,    !"` → `"Hello, world!"`。
- 输入 `"\t\n"`：`"Hello, \t\n!"` → `"Hello, world!"`。
- 输入 `"  Ada  "`：`"Hello,   Ada  !"` → `"Hello, Ada!"`。
- 输入 `" \tAda  de LOVELACE\n "`：`"Hello,  \tAda  de LOVELACE\n !"` → `"Hello, Ada  de LOVELACE!"`。

空字符串和纯空白回退 world，两侧空白删除，普通姓名、内部空格与大小写保持正确。未发现回归。
