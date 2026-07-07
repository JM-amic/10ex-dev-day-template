/**
 * FileInput Component - File picker that reads the chosen file as text
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { EngineComponentProps, ActionDefinition } from '@/engine/types';
import { useUIEngine } from '@/engine/UIEngineContext';

interface EngineFileInputProps extends EngineComponentProps {
  onFileRead?: ActionDefinition;
  accept?: string;
  label?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  className?: string;
}

export function EngineFileInput({
  onFileRead,
  accept,
  label,
  name,
  disabled = false,
  required = false,
  error,
  className,
}: EngineFileInputProps) {
  const { dispatch } = useUIEngine();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onFileRead) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const format = file.name.toLowerCase().endsWith('.xml') ? 'xml' : 'json';
      dispatch(onFileRead, { event: { text, filename: file.name, format } });
    };
    reader.readAsText(file);
  };

  const inputId = name || `file-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <Label htmlFor={inputId}>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Input
        id={inputId}
        name={name}
        type="file"
        accept={accept}
        onChange={handleChange}
        disabled={disabled}
        required={required}
        className={cn(error && 'border-destructive')}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
