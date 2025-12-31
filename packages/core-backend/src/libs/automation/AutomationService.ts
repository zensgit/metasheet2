
import { EventBus } from '../../events/EventBus';

export interface IAutomationTrigger {
  id: string;
  event: string;
  condition?: (payload: any) => boolean;
  action: (payload: any) => Promise<void>;
}

export class AutomationService {
  private triggers: IAutomationTrigger[] = [];

  static inject = [EventBus];

  constructor(private eventBus: EventBus) {
    // Listen to all events and match against triggers
    // In a real system, we might optimize this mapping
  }

  public registerTrigger(trigger: IAutomationTrigger) {
    this.triggers.push(trigger);
    
    // Subscribe to the specific event
    this.eventBus.subscribe(trigger.event, async (payload) => {
      // Check condition
      if (trigger.condition && !trigger.condition(payload)) {
        return;
      }
      
      console.log(`[Automation] Triggered: ${trigger.id}`);
      try {
        await trigger.action(payload);
      } catch (error) {
        console.error(`[Automation] Action failed for trigger ${trigger.id}:`, error);
      }
    });
  }

  public getTriggers() {
    return this.triggers;
  }
}
