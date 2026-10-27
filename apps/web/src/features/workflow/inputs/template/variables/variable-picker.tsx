import { useState } from 'react';
import { Braces } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { AvailableOutput, NodeOutputVariables } from '../types';
import { VariablePickerContent } from './variable-picker-content';

export function VariablePicker({
  portName,
  open,
  onOpenChange,
  outputs,
  variables,
  disabled,
  onSelect,
}: {
  portName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputs: readonly AvailableOutput[];
  variables: NodeOutputVariables;
  disabled: boolean;
  onSelect: (output: AvailableOutput) => void;
}) {
  const [search, setSearch] = useState('');

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSearch('');
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`向${portName}插入变量`}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Braces size={13} />
          <span>插入变量</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        data-testid="button-variable-popover"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <VariablePickerContent
          portName={portName}
          outputs={outputs}
          variables={variables}
          search={search}
          onSearchChange={setSearch}
          onSelect={onSelect}
        />
      </PopoverContent>
    </Popover>
  );
}
