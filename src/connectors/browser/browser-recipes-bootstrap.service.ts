import { Injectable, OnModuleInit } from '@nestjs/common';
import { BrowserRecipeRegistry } from './browser-recipe.registry';
import { VozXenForoBrowserRecipe } from './recipes/xenforo-browser.recipe';

@Injectable()
export class BrowserRecipesBootstrapService implements OnModuleInit {
  constructor(
    private readonly registry: BrowserRecipeRegistry,
    private readonly voz: VozXenForoBrowserRecipe,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.voz);
  }
}
