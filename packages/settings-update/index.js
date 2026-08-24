// 顶层入口：部分加载路径（如目录导入）会直接找 <dir>/index.js，
// 这里 re-export 真实实现，保证两种解析方式都可用。
export { apply } from './lib/index.js';
