import zipfile, re, os, glob, html

def extract(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', errors='ignore')
    xml = xml.replace('</w:p>', '\n')
    xml = xml.replace('<w:br/>', '\n').replace('<w:br />', '\n')
    xml = re.sub(r'<w:tab/>', '\t', xml)
    text = re.sub(r'<[^>]+>', '', xml)
    text = html.unescape(text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
outdir = os.path.join(base, 'scripts', 'docx_text')
os.makedirs(outdir, exist_ok=True)

for f in glob.glob(os.path.join(base, '*.docx')):
    name = os.path.splitext(os.path.basename(f))[0]
    try:
        txt = extract(f)
    except Exception as e:
        txt = f"ERROR: {e}"
    outpath = os.path.join(outdir, name + '.txt')
    with open(outpath, 'w', encoding='utf-8') as out:
        out.write(txt)
    print(f"{name}: {len(txt)} chars -> {outpath}")
