import { Injectable, NgZone } from '@angular/core';
import * as fs from 'fs';
import * as path from 'path';
import * as mkdirp from 'mkdirp';
import * as copyDir from 'copy-dir';
import { Observable, Observer, Subject, BehaviorSubject } from 'rxjs';
import { NotificationsService } from 'angular2-notifications';
import { LocalStorage } from 'ng2-webstorage';

import { ConfirmationService } from './confirmation.service';
import { Dialog } from '../models/dialog';
import { Project } from '../models/project';
import { Workspace } from '../models/workspace';
import { LocalStorageService } from 'ng2-webstorage';
import { UserPreferences } from '../models/user-preferences';
import { RecentProject } from '../models/recent-project';
import { ElectronService } from './electron.service';
import { ipcRenderer } from 'electron';

@Injectable()
export class ProjectService {
  public workspace: Workspace = new Workspace();
  public workspaceSubscription = new BehaviorSubject<Workspace>(null);
  public userPreferences: UserPreferences = new UserPreferences();

  constructor(
    private confirmationService: ConfirmationService,
    private notificationsService: NotificationsService,
    private ngZone: NgZone,
    private storage: LocalStorageService,
    private electronService: ElectronService
  ) {
    this.workspaceSubscription.next(this.workspace);
    this.updatePersistedWorkspace();
    const preferences = this.storage.retrieve('user-preferences');
    if (preferences) {
      this.userPreferences = preferences;
      this.userPreferences.recentProjects = this.userPreferences.recentProjects.sort((a, b) => {
        if (a.lastOpened && b.lastOpened) {
          return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
        } else {
          return 0;
        }
      });
      console.log(this.userPreferences.recentProjects);
    }
  }

  public getWorkspace(): Observable<Workspace> {
    return this.workspaceSubscription.asObservable();
  }

  /**
   * Creates a project file and the basic folder structure with basic files
   * @param project Project to be created
   * @param directory Absolute path to the container directory
   * @param file Absolute path to the project file
   */
  public createProject(project: Project, directory: string, file: string): Observable<boolean> {
    this.workspace.project = project;
    this.workspace.path = directory;
    this.workspace.projectFile = file;
    this.workspaceSubscription.next(this.workspace);
    this.updatePersistedWorkspace();
    this.addToRecentProjects(project);
    return this.createProjectStructure(directory, file);
  }

  public openRecentProject(recentProject: RecentProject): Observable<boolean> {
    return this.openProject(recentProject.projectFile);
  }

  public openProject(filePath: string): Observable<boolean> {
    const retValue = new Observable<boolean>((observer) => {
      fs.readFile(filePath, (err, data) => {
        if (err) {
          this.notificationsService.alert('Ocurrió un error al abrir el proyecto');
          observer.next(false);
          observer.complete();
        } else {
          try {
            const parsedData = JSON.parse(data as any);
            if (!new Project().isProject(parsedData)) {
              throw new Error();
            } else {
              this.workspace.project = parsedData;
              this.workspace.projectFile = filePath;
              this.workspace.changes = false;
              this.electronService.ipcRenderer.send('workspace-changes', false);
              this.workspace.path = path.dirname(filePath);
              this.workspaceSubscription.next(this.workspace);
              this.updatePersistedUserPreferences();
              this.addToRecentProjects(this.workspace.project);
              observer.next(true);
              observer.complete();
            }
          } catch (error) {
            console.log('Error al parsear json del proyecto');
            this.notificationsService.alert('Ocurrión un error al leer el proyecto');
            observer.next(false);
            observer.complete();
          }
        }
      });
    });
    return retValue;
  }

  public saveCurrentProject() {
    this.workspace.changes = false;
    this.electronService.ipcRenderer.send('workspace-changes', false);
    this.workspaceSubscription.next(this.workspace);
    this.saveProjectToFile(this.workspace.projectFile);
  }

  public registerProjectChange() {
    this.workspace.changes = true;
    this.electronService.ipcRenderer.send('workspace-changes', true);
    this.workspaceSubscription.next(this.workspace);
    this.updatePersistedWorkspace();
  }

  public getProjectChange() {
    return this.workspace.changes;
  }

  public existsOpenProject(): boolean {
    return this.workspace.project != null;
  }

  public setBlocklyBlocks(blocks: any) {
    if (this.workspace.project) {
      if (this.workspace.project.blocks !== blocks) {
        this.workspace.project.blocks = blocks;
        this.registerProjectChange();
      }
    }
  }

  public getBlocklyBlocks(): string {
    if (this.workspace.project) {
      if (this.workspace.project.blocks) {
        return this.workspace.project.blocks;
      }
    }
    return null;
  }

  public setBlocklyCode(code: string) {
    if (this.workspace.project) {
      this.workspace.project.code = code;
      this.workspaceSubscription.next(this.workspace);
      this.updatePersistedWorkspace();
    }
  }

  public getBlocklyCode(): string {
    if (this.workspace.project) {
      if (this.workspace.project.code) {
        return this.workspace.project.code;
      }
    }
    return null;
  }

  public getRecentProjects(): RecentProject[] {
    return this.userPreferences.recentProjects;
  }

  public removeRecentProject(project: RecentProject) {
    /* If the project exists, it is removed from the array */
    if (this.userPreferences.recentProjects) {
      const index = this.userPreferences.recentProjects.findIndex((recentProject) => {
        return recentProject.name === project.name && recentProject.projectFile === project.projectFile;
      });
      console.log('Removiendo', project);
      console.log('Indice', index);
      if (-1 !== index) {
        this.userPreferences.recentProjects.splice(index, 1);
        /* Order recent projects by date */
        this.userPreferences.recentProjects = this.userPreferences.recentProjects.sort((a, b) => {
          if (a.lastOpened instanceof Date && b.lastOpened instanceof Date) {
            return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
          } else if (a.lastOpened instanceof Date) {
            return -1;
          } else {
            return 1;
          }
        });
        this.updatePersistedUserPreferences();
      }
    }
  }

  private saveProjectToFile(file): boolean {
    console.log('Trying to save', file);
    let fileDescriptor: number;
    /* Try to open file */
    try {
      fileDescriptor = fs.openSync(file, 'w');
    } catch (error) {
      this.notificationsService.alert('No se puede crear el archivo');
      return false;
    }

    /* Try to write to file */
    try {
      fs.writeFileSync(file, JSON.stringify(this.workspace.project));
    } catch (error) {
      this.notificationsService.alert('No se puede escribir el archivo');
      /* Closing the file */
      fs.closeSync(fileDescriptor);
      return false;
    }

    /* Closing the file */
    fs.closeSync(fileDescriptor);

    this.ngZone.run(() => {
      this.notificationsService.success(
        'Guardar Proyecto',
        'Guardado',
        {
          timeOut: 3000,
          showProgressBar: true,
          pauseOnHover: false,
          clickToClose: false,
          maxLength: 10,
          animate: 'fromRight'
        }
      );
    });
    return true;
  }

  /**
   * Creates directories and copies the files needed to compile and load code to the board.
   * @param directory String with the destination directory path
   * @param file String with the project file name
   * @returns Observable with result
   */
  private createProjectStructure(directory: string, file: string): Observable<boolean> {
    const retValue = new Observable<boolean>((observer) => {
      copyDir(__dirname + '/assets/templates/g1', directory, (err) => {
        if (err) {
          console.error(err);
          observer.next(false);
          observer.complete();
          return;
        }
        if (this.saveProjectToFile(file)) {
          console.log('Archivo cbp creado');
          observer.next(true);
        } else {
          console.error('No se pudo crear el cbp');
          observer.next(false);
        }
        observer.complete();
        return;
      });
    });
    return retValue;
  }

  private updatePersistedWorkspace() {
    this.storage.store('workspace', this.workspace);
  }

  private updatePersistedUserPreferences() {
    this.storage.store('user-preferences', this.userPreferences);
  }

  private addToRecentProjects(project: Project) {
    /* If the project does not exists, it is pushed into the array */
    if (this.userPreferences.recentProjects) {
      const index = this.userPreferences.recentProjects.findIndex((recentProject) => {
        return recentProject.name === project.name && recentProject.projectFile === this.workspace.projectFile;
      });
      if (-1 === index) {
        const recentProject = new RecentProject();
        recentProject.name = project.name;
        recentProject.projectFile = this.workspace.projectFile;
        this.userPreferences.recentProjects.push(recentProject);
        /* If there are more than 10 projects saved, delete the older one */
        if (this.userPreferences.recentProjects.length > 10) {
          this.userPreferences.recentProjects.splice(0, 1);
        }

        /* Order recent projects by date */
        this.userPreferences.recentProjects = this.userPreferences.recentProjects.sort((a, b) => {
          if (a.lastOpened instanceof Date && b.lastOpened instanceof Date) {
            return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
          } else if (a.lastOpened instanceof Date) {
            return -1;
          } else {
            return 1;
          }
        });

        this.updatePersistedUserPreferences();
      } else {
        this.userPreferences.recentProjects[index].lastOpened = new Date();
        this.updatePersistedUserPreferences();
      }
    } else {
      this.userPreferences.recentProjects = [];
      const recentProject = new RecentProject();
      recentProject.name = project.name;
      recentProject.projectFile = this.workspace.projectFile;
      this.userPreferences.recentProjects.push(recentProject);
      this.updatePersistedUserPreferences();
    }
  }
}
