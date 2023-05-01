function getQueryParams() {
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    return urlParams;
  }
  
  function getMarkdownFileUrl() {
    const queryParams = getQueryParams();
    const directory = queryParams.get('dir') || '';
    const markdownFilename = queryParams.get('file') || 'principal.md';
    return directory ? `${directory}/${markdownFilename}` : markdownFilename;
  }
  
  async function fetchMarkdown(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Erreur HTTP! Statut: ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      console.error(`Erreur lors de la récupération du fichier Markdown: ${error}`);
      return '';
    }
  }

  function extractDirectoryFromFilePath(filePath) {
    const lastSlashIndex = filePath.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      return '';
    }
    return filePath.substring(0, lastSlashIndex);
  }
    
  function convertMarkdownToHTML(markdownText) {
    const converter = new showdown.Converter();
    return converter.makeHtml(markdownText);
  }
  
  function replaceObsidianLinks(htmlContent) {
    const queryParams = getQueryParams();
    const directory = queryParams.get('dir') || extractDirectoryFromFilePath(queryParams.get('file') || '');
    const dirParam = directory ? `&dir=${encodeURIComponent(directory)}` : '';
  
    const regex = /\[\[(.+?)\]\]/g;
    return htmlContent.replace(regex, (match, linkText) => {
      const linkUrl = `?file=${encodeURIComponent(linkText)}.md&${dirParam}`;
      return `<a href="${linkUrl}">${linkText}</a>`;
    });
  }
  
  async function displayMarkdown() {
    const markdownFileUrl = getMarkdownFileUrl();
    const markdownText = await fetchMarkdown(markdownFileUrl);
    let htmlContent = convertMarkdownToHTML(markdownText);
    htmlContent = replaceObsidianLinks(htmlContent);
    document.getElementById('main_content').innerHTML = htmlContent;
  }
  
 
  