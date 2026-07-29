import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders assistant Markdown safely. react-markdown does not execute raw HTML by
 * default, which mitigates XSS from model/document output (§21). Code blocks get
 * a language label and a copy button (§5, §10).
 */
export default function Markdown({ children }) {
  return (
    <div className="prose-chat max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          code({ inline, className, children: code, ...props }) {
            if (inline) {
              return (
                <code className={className} {...props}>
                  {code}
                </code>
              );
            }
            const lang = /language-(\w+)/.exec(className || '')?.[1] || 'text';
            return <CodeBlock lang={lang}>{String(code).replace(/\n$/, '')}</CodeBlock>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ lang, children }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative my-3">
      <div className="flex items-center justify-between rounded-t-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">
        <span>{lang}</span>
        <button onClick={copy} className="hover:text-white">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code>{children}</code>
      </pre>
    </div>
  );
}
