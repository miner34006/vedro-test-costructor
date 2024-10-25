import * as vscode from 'vscode';
import hljs from 'highlight.js';
import * as path from 'path';

let panel: vscode.WebviewPanel | undefined;
let messageListenerDisposable: vscode.Disposable | undefined;
let cacheFunctionsData: Map<string, { name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number }[]> = new Map();

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'python' }, new FunctionCodeLensProvider())
    );

    vscode.commands.registerCommand("vedro-test-constructor.enableCodeLens", () => {
        vscode.workspace.getConfiguration("vedro-test-constructor").update("enableCodeLens", true);
    });

    vscode.commands.registerCommand("vedro-test-constructor.disableCodeLens", () => {
        vscode.workspace.getConfiguration("vedro-test-constructor").update("enableCodeLens", false);
    });

    vscode.commands.registerCommand("vedro-test-constructor.resetCache", () => {
        cacheFunctionsData = new Map();
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.showFunctionListWebview', async (documentUri: vscode.Uri, functionToReplaceNameRange: vscode.Range, type: string, functionToReplaceName: string, needFilter: boolean) => {
            let foundFunctionsData: { name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number}[] = [];
            if (!cacheFunctionsData.has(type)) {
                const documents = await openPythonDocuments();
                foundFunctionsData = await getFunctionsData(documents, type);
                cacheFunctionsData.set(type, foundFunctionsData);
            } else {
                foundFunctionsData = cacheFunctionsData.get(type) || [];
            }

            if (needFilter) {
                foundFunctionsData = await filterFunctionsData(foundFunctionsData, functionToReplaceName);
            }

            const document = await vscode.workspace.openTextDocument(documentUri);
            const currentFileFunctionsData = await getFunctionsData([document], type);

            if (!panel) {
                panel = vscode.window.createWebviewPanel(
                    'functionList',
                    'Select Function',
                    vscode.ViewColumn.Beside, // Open in split screen mode
                    { enableScripts: true }
                );

                panel.onDidDispose(
                    () => {
                        panel = undefined;
                    },
                    null,
                    context.subscriptions
                );
            }

            const fullFunctionToReplaceName = type + functionToReplaceName;
            panel.webview.html = await getWebviewContent(foundFunctionsData, fullFunctionToReplaceName, functionToReplaceNameRange,
                panel, context
            );

            // Dispose the old message listener if it exists
            if (messageListenerDisposable) {
                messageListenerDisposable.dispose();
            }

            messageListenerDisposable = panel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'replace') {
                        console.log(`Received replace command, selected function is ${message.functionName}`);
                        const selectedFunction = foundFunctionsData.find(f => f.id === message.functionID);
                        if (selectedFunction != undefined) {
                            const functionToReplaceRange = currentFileFunctionsData.find(f => rangesAreEqual(f.nameRange, functionToReplaceNameRange))?.functionRange;
                            await replaceFunction(document, functionToReplaceRange, selectedFunction.fullFunction);
                        }
                    }
                },
                undefined,
                context.subscriptions
            );
        })
    );
}

class FunctionCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        if (vscode.workspace.getConfiguration("vedro-test-constructor").get("enableCodeLens", true)) {

            const text = document.getText();
            const functionPattern = new RegExp(`(async\\s+)?def\\s+(given|when|then|and)(\\w*)`, 'g');
            let match;

            while (match = functionPattern.exec(text)) {
                console.log(`Found function: ${match[0]}`);
                console.log(`Type: ${match[2]}`);

                const type = match[2];
                const functionName = match[3];

                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + match[0].length);
                const functionNameRange = new vscode.Range(startPos, endPos);

                codeLenses.push(new vscode.CodeLens(functionNameRange, {
                    title: `Search ${type}`,
                    command: 'extension.showFunctionListWebview',
                    arguments: [document.uri, functionNameRange, type, functionName, false]
                }));
                codeLenses.push(new vscode.CodeLens(functionNameRange, {
                    title: `Search similar ${type}`,
                    command: 'extension.showFunctionListWebview',
                    arguments: [document.uri, functionNameRange, type, functionName, true]
                }));
            }
        }
        return codeLenses;
    }
}

async function getFunctionsData(documents: vscode.TextDocument[], type: string, filterName: string = ""): Promise<{ name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number}[]> {
    const functionsMap: Map<string, { name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number }> = new Map();
    const functionPattern = new RegExp(`(async\\s+)?def\\s+(${type})(\\w*)`, 'g');

    let i = 0;
    for (const document of documents) {
        const text = document.getText();
        let match: RegExpExecArray | null;

        while ((match = functionPattern.exec(text)) !== null) {
            const functionName = (match[2] || '') + match[3];
            const startPos = document.positionAt(match.index);
            const endNamePos = document.positionAt(match.index + match[0].length);
            const functionNameRange = new vscode.Range(startPos, endNamePos);

            // Get the line of the function definition
            const startLine = startPos.line;
            const startIndent = document.lineAt(startLine).firstNonWhitespaceCharacterIndex;

            let endLine = startLine;
            let foundFunctionEnd = false;
            const lines = document.getText(new vscode.Range(new vscode.Position(startLine + 1, 0), new vscode.Position(document.lineCount, 0))).split('\n');

            // Go through the lines to find the end of the function
            for (let line = 0; line < lines.length; line++) {
                const lineText = lines[line];
                const currentIndent = lineText.search(/\S|$/);

                if (lineText.trim() === '' || currentIndent > startIndent) {
                    endLine = startLine + 1 + line;
                } else if (currentIndent <= startIndent && lineText.trim() !== '') {
                    foundFunctionEnd = true;
                    break;
                }
            }

            // If no non-indented line was found, set endPos to the end of the document
            if (!foundFunctionEnd) {
                endLine = document.lineCount - 1;
            }

            if (filterName === '' || functionName.includes(filterName)) {
                const endPos = new vscode.Position(endLine, document.lineAt(endLine).text.length);
                const functionRange = new vscode.Range(startPos, endPos);
                const fullFunction = normalizeIndent(document.getText(functionRange), 4);

                if (!functionsMap.has(fullFunction)) {
                    functionsMap.set(fullFunction, {
                        name: functionName,
                        nameRange: functionNameRange,
                        functionRange: functionRange,
                        fullFunction: fullFunction,
                        id: i
                    });
                    i++;
                }
            }
        }
    }

    // Convert Map values to an array
    return Array.from(functionsMap.values());
}

async function filterFunctionsData(functionsData: { name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number}[], filterName: string = ""): Promise<{ name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number}[]> {
    if (filterName === "") {
        return functionsData;
    }
    return functionsData.filter(f => f.name.includes(filterName));
}

async function openPythonDocuments(): Promise<vscode.TextDocument[]> {
    try {
        const pythonFiles = await vscode.workspace.findFiles('**/scenarios/**/*.py');
        const documents = await Promise.all(pythonFiles.map(async file => {
            if (!file) {
                // console.error("File is undefined or null");
                return null;
            }
            try {
                return await vscode.workspace.openTextDocument(file);
            } catch (error) {
                // console.error(`Error opening document for file ${file.fsPath}:`, error);
                return null;
            }
        }));

        // Отфильтровываем null значения
        const validDocuments = documents.filter((doc): doc is vscode.TextDocument => doc !== null);

        if (validDocuments.length === 0) {
            console.error("No valid documents opened");
        }

        return validDocuments;
    } catch (error) {
        console.error("Error opening text documents:", error);
        return [];
    }
}

function normalizeIndent(funcionText: string, indent: number): string {
    if (indent <= 0) {
        throw new Error("Indent must be a positive number");
    }

    // Разделяем входную строку на строки
    const lines = funcionText.split('\n');

    // Определяем целевой отступ в виде строки пробелов
    const targetIndent = ' '.repeat(indent);

    // Регулярное выражение для определения текущего отступа
    const indentRegex = /^(\s*)/;

    // Находим минимальный отступ, чтобы использовать его как базовый
    let minIndent = Number.MAX_SAFE_INTEGER;
    for (const line of lines) {
        const match = line.match(indentRegex);
        if (match && match[1].length < minIndent && match[1].length > 0) {
            minIndent = match[1].length;
        }
    }

    // Если минимальный отступ не найден (все строки без отступов), устанавливаем его в 0
    if (minIndent === Number.MAX_SAFE_INTEGER) {
        minIndent = 0;
    }

    // Преобразуем строки с учетом нового отступа
    const normalizedLines = lines.map(line => {
        const match = line.match(indentRegex);
        if (match && match[1].length >= minIndent) {
            const currentIndentLength = match[1].length;
            const newIndentLength = Math.max(0, currentIndentLength - minIndent + indent);
            return ' '.repeat(newIndentLength) + line.trimStart();
        }
        return line;
    });

    // Объединяем строки обратно в одну строку
    return normalizedLines.join('\n');
}

async function replaceFunction(document: vscode.TextDocument, originalRange: vscode.Range | undefined, selectedFunctionText: string) {
    if (!originalRange) {
        return;
    }

    // Найдите уже открытый редактор для документа, если он существует
    let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === document.uri.toString());

    // Если редактор не найден, откройте документ в текущем окне
    if (!editor) {
        editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    }

    const originalStartCharacter = originalRange.start.character; // Получаем начальный отступ исходной функции

    // Разбиваем новую функцию на строки
    const lines = selectedFunctionText.split('\n');
    if (lines.length > 1) {
        // Добавляем исходный отступ ко всем строкам новой функции, кроме первой
        for (let i = 1; i < lines.length - 1; i++) {
            lines[i] = ' '.repeat(originalStartCharacter) + lines[i];
        }
    }

    // Объединяем строки обратно в одну строку
    const indentedSelectedFunctionText = lines.join('\n');

    await editor.edit(editBuilder => {
        // Удаляем оригинальную функцию
        editBuilder.delete(originalRange);

        // Вставляем новую функцию с учетом исходного отступа
        editBuilder.insert(originalRange.start, indentedSelectedFunctionText);
    });
}

async function getWebviewContent(foundFunctionsData: { name: string, nameRange: vscode.Range, functionRange: vscode.Range, fullFunction: string, id: number }[], selectedFunctionName: string, functionToReplaceNameRange: vscode.Range, panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<string> {

    const stylePath = path.join(context.extensionPath, 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.css');
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(stylePath));

    const functionList = Array.from(foundFunctionsData).map(f => {
        const functionText = f.fullFunction;
        const code = hljs.highlight('python', functionText).value;
        if (!rangesAreEqual(f.nameRange, functionToReplaceNameRange)) {
            return `
                <div class="function-item" data-function-name="${f.name}" data-function-text="${functionText}">
                    <button onclick="replace(${f.id}, '${f.name}')"> Replace</button> with <h4>${f.name}</h4>
                    <pre><code class="javascript fullWidth">${code}</code></pre>
                </div>
            `;
        }
    }).join('');


    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="${styleUri}">
        <title>Function List</title>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.26.0/themes/prism.min.css" rel="stylesheet" />
        <style>
            .function-item {
                border-bottom: 1px solid #ccc;
                padding: 10px 0;
            }
            pre {
                width: 100%;
                max-width: 100%;
                overflow: auto;
                box-sizing: border-box;
            }
            code {
                display: block;
                white-space: pre-wrap;
            }
            .header {
                position: sticky;
                top: 0;
                background-color: var(--vscode-editor-background);
                padding-top: 10px;
                padding-bottom: 10px;
            }
            h4 {
                margin: 0;
                font-size: 16px;
                display: inline-block;
            }
            p {
                margin: 5px 0;
                font-size: 14px;
            }
            button {
                display: inline-block;
                margin-top: 5px;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <p>Replacing <b>${selectedFunctionName}</b></p>
            <input type="text" id="search" placeholder="Search functions..." oninput="filterFunctions()">
        </div>
        ${functionList}
        <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.26.0/prism.min.js"></script>
        <script>
            const vscode = acquireVsCodeApi();

            function replace(functionID, functionName) {
                vscode.postMessage({
                    command: 'replace',
                    functionID: functionID,
                    functionName: functionName
                });
            }

            function filterFunctions() {
                const searchValue = document.getElementById('search').value.toLowerCase();
                const functionItems = document.getElementsByClassName('function-item');

                Array.from(functionItems).forEach(item => {
                    const functionName = item.getAttribute('data-function-name').toLowerCase();
                    const functionText = item.getAttribute('data-function-text').toLowerCase();
                    if (functionName.includes(searchValue) || functionText.includes(searchValue)) {
                        item.style.display = '';
                    } else {
                        item.style.display = 'none';
                    }
                });
            }
        </script>
    </body>
    </html>`;
}

function rangesAreEqual(range1: vscode.Range, range2: vscode.Range): boolean {
    return range1.start.line === range2.start.line &&
           range1.start.character === range2.start.character &&
           range1.end.line === range2.end.line &&
           range1.end.character === range2.end.character;
}

export function deactivate() {}