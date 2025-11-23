const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ========== 配置区域：请根据你的实际情况修改以下变量 ==========
// 你的 Hexo 源文件目录，即 _posts 文件夹的父目录
const HEXO_SOURCE_DIR = 'D:\\Users\\fei\\gitrepo\\myblog\\myblog\\source';
// 你的 PicGo-CLI 可执行文件的完整路径，例如在 Windows 上可能是 'C:\\Users\\YourName\\AppData\\Roaming\\npm\\picgo'
const PICGO_CLI_PATH = 'picgo';
// ========== 配置结束 ==========

const POSTS_DIR = path.join(HEXO_SOURCE_DIR, '_posts');

/**
 * 使用 PicGo-CLI 上传单张图片并返回 URL
 * @param {string} imagePath - 图片的绝对路径
 * @returns {Promise<string>} 图床上的图片 URL
 */
async function uploadImageWithPicGo(imagePath) {
    try {
        const { stdout, stderr } = await execAsync(`"${PICGO_CLI_PATH}" upload "${imagePath}"`);
        
        if (stderr) {
            console.error(`[PicGo Stderr] 上传 ${imagePath} 时产生警告:`, stderr);
        }

        // 关键修复：从混合输出中提取有效的URL
        const extractImageUrl = (output) => {
            // 1. 尝试找到明显的URL格式（以http://或https://开头）
            const urlMatch = output.match(/https?:\/\/[^\s]+/);
            if (urlMatch) return urlMatch[0];
            
            // 2. 尝试解析为JSON数组（PicGo的标准返回格式）
            try {
                const jsonOutput = JSON.parse(output);
                if (Array.isArray(jsonOutput) && jsonOutput[0]?.imgUrl) {
                    return jsonOutput[0].imgUrl;
                }
            } catch (e) {
                // 不是JSON格式，继续尝试其他方法
            }
            
            // 3. 尝试找到包含图片扩展名的行
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            for (const line of output.split('\n')) {
                const trimmedLine = line.trim();
                if (imageExtensions.some(ext => trimmedLine.includes(ext))) {
                    return trimmedLine;
                }
            }
            
            return null;
        };

        const imageUrl = extractImageUrl(stdout);
        
        if (!imageUrl) {
            throw new Error(`无法从 PicGo 输出中解析出 URL:\n${stdout}`);
        }
        
        console.log(`  图片上传成功: ${path.basename(imagePath)} -> ${imageUrl}`);
        return imageUrl;
    } catch (error) {
        console.error(`  图片上传失败 (${path.basename(imagePath)}):`, error.message);
        throw error;
    }
}

/**
 * 处理单个 Markdown 文件
 * @param {string} filePath - Markdown 文件的路径
 */
async function processMarkdownFile(filePath) {
    console.log(`\n处理文件中: ${filePath}`);
    
    try {
        let content = await fs.readFile(filePath, 'utf-8');
        // 正则表达式匹配 Markdown 图片语法 ![...](...)
        const imageRegex = /!\[(.*?)\]\((.*?)\)/g;
        const matches = [...content.matchAll(imageRegex)];
        const localImageMatches = matches.filter(match => {
            const imageUrl = match[2];
            // 过滤掉网络图片（以 http/https 开头）
            return !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://');
        });

        if (localImageMatches.length === 0) {
            console.log('  未发现本地图片引用，跳过。');
            return;
        }

        console.log(`  发现 ${localImageMatches.length} 个本地图片引用。`);

        // 用于存储旧URL到新URL的映射
        const urlMap = new Map();

        // 首先，处理所有图片的上传，并确认成功获取了新URL
        for (const match of localImageMatches) {
            const [fullMatch, altText, oldImagePath] = match;

            // 构建图片的绝对路径
            const imageDir = path.dirname(filePath); // Markdown 文件所在目录
            const imageName = path.basename(oldImagePath);
            // 假设图片存放在与 .md 文件同名的目录中
            const imageFolderName = path.basename(filePath, '.md');
            const absoluteImagePath = path.join(imageDir, imageFolderName, imageName);

            console.log(`  正在处理: ${imageName}`);
            try {
                const newImageUrl = await uploadImageWithPicGo(absoluteImagePath);

                // 核心修改：增加对 newImageUrl 有效性的判断
                if (newImageUrl && (newImageUrl.startsWith('http://') || newImageUrl.startsWith('https://'))) {
                    // 确认是有效的网络URL，才存入映射表
                    urlMap.set(oldImagePath, newImageUrl);
                    console.log(`    ✓ 图片上传成功，新URL已记录。`);
                } else {
                    // 如果上传返回的URL无效，则跳过此图片的替换
                    console.error(`    ✗ 跳过此图片：从PicGo获取的URL无效 -> ${newImageUrl}`);
                    // 可以选择将旧的本地路径映射给它自身，或者直接跳过，这里选择跳过
                    // urlMap.set(oldImagePath, oldImagePath);
                }
            } catch (uploadError) {
                console.error(`    ✗ 图片上传失败，跳过: ${absoluteImagePath}`);
                // 上传过程出错，跳过此图片
                continue;
            }
        }

        // 然后，仅对成功上传并获取到新URL的图片进行替换
        let replacementCount = 0;
        if (urlMap.size > 0) {
            for (const [oldPath, newUrl] of urlMap) {
                const escapedOldPath = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`!\\[.*?\\]\\(${escapedOldPath}\\)`, 'g');
                content = content.replace(regex, `![](${newUrl})`);
                replacementCount++;
                console.log(`    链接已替换: ${oldPath} -> ${newUrl}`);
            }
            // 将修改后的内容写回文件
            await fs.writeFile(filePath, content, 'utf-8');
            console.log(`  文件更新完成: ${filePath} (成功替换 ${replacementCount} 个链接)`);
        } else {
            // 如果没有任何图片成功上传并获得新URL，则跳过文件写入
            console.log(`  未有任何图片需要更新，跳过文件: ${filePath}`);
        }


    } catch (error) {
        console.error(`  处理文件时发生错误 (${filePath}):`, error.message);
    }
}

/**
 * 主函数：遍历 _posts 目录并处理所有 .md 文件
 */
async function main() {
    console.log('开始批量处理 Hexo 博文中的本地图片...');
    console.log(`扫描目录: ${POSTS_DIR}`);

    try {
        const items = await fs.readdir(POSTS_DIR, { withFileTypes: true });
        const mdFiles = items.filter(item => 
            item.isFile() && path.extname(item.name).toLowerCase() === '.md'
        ).map(file => path.join(POSTS_DIR, file.name));

        if (mdFiles.length === 0) {
            console.log('在 _posts 目录中未找到任何 .md 文件。');
            return;
        }

        console.log(`找到 ${mdFiles.length} 个 Markdown 文件。`);

        // 依次处理每个文件
        for (const file of mdFiles) {
            await processMarkdownFile(file);
        }

        console.log('\n所有文件处理完成！');

    } catch (error) {
        console.error('遍历 _posts 目录时发生错误:', error.message);
    }
}

// 启动脚本
main().catch(console.error);